import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomInt } from 'node:crypto'
import { requirePermission, type ManagementPermission } from '../../auth/management.js'
import { writeStaffAuditLog } from '../../auth/audit.js'
import { getDb } from '../../db/client.js'

const VALID_STATUSES = new Set([
  'pending',
  'under_review',
  'approved',
  'rejected',
  'cancelled',
])

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  try {
    const requestedStatus = String(req.body?.status ?? '').trim()

    const supportedActions = new Set([
      'under_review',
      'approved',
      'rejected',
      'cancelled',
    ])

    if (
      req.method !== 'GET' &&
      (req.method !== 'PATCH' || !supportedActions.has(requestedStatus))
    ) {
      return res.status(400).json({
        ok: false,
        error: 'This application action is not supported.',
      })
    }

    const permission: ManagementPermission =
      req.method === 'GET' || requestedStatus === 'under_review'
        ? 'applications.view'
        : requestedStatus === 'approved'
          ? 'applications.approve'
          : 'applications.reject'

    const user = await requirePermission(req, permission)

    if (!user) {
      return res.status(403).json({
        ok: false,
        error: 'You do not have permission to access account applications.',
      })
    }

    const db = getDb()

    if (req.method === 'GET') {
      const requestedStatus = String(req.query.status ?? '').trim()

      const values: string[] = []
      let where = ''

      if (requestedStatus) {
        if (!VALID_STATUSES.has(requestedStatus)) {
          return res.status(400).json({
            ok: false,
            error: 'Invalid application status.',
          })
        }

        values.push(requestedStatus)
        where = 'WHERE aa.status = $1'
      }

      const result = await db.query(
        `
          SELECT
            aa.id,
            aa.customer_id,
            aa.account_type,
            aa.first_name,
            aa.last_name,
            aa.email,
            aa.phone,
            aa.status,
            aa.review_notes,
            aa.reviewed_by,
            aa.created_at,
            aa.updated_at,
            aa.reviewed_at,
            c.customer_number,
            c.status AS customer_status
          FROM account_applications aa
          LEFT JOIN customers c
            ON c.id = aa.customer_id
          ${where}
          ORDER BY
            CASE aa.status
              WHEN 'pending' THEN 1
              WHEN 'under_review' THEN 2
              WHEN 'approved' THEN 3
              WHEN 'rejected' THEN 4
              WHEN 'cancelled' THEN 5
              ELSE 6
            END,
            aa.created_at DESC
          LIMIT 250
        `,
        values,
      )

      return res.status(200).json({
        ok: true,
        applications: result.rows,
      })
    }

    if (req.method === 'PATCH') {
      const applicationId = String(req.body?.applicationId ?? '').trim()
      const status = String(req.body?.status ?? '').trim()
      const reviewNotes =
        req.body?.reviewNotes === undefined
          ? null
          : String(req.body.reviewNotes).trim()

      if (!applicationId || !status) {
        return res.status(400).json({
          ok: false,
          error: 'Application ID and status are required.',
        })
      }

      if (!VALID_STATUSES.has(status)) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid application status.',
        })
      }

      if (
        status === 'rejected' &&
        (!reviewNotes || reviewNotes.length < 3)
      ) {
        return res.status(400).json({
          ok: false,
          error: 'A review note is required when rejecting an application.',
        })
      }

      const client = await db.connect()

      try {
        await client.query('BEGIN')

        const existing = await client.query(
          `
            SELECT
              id,
              customer_id,
              account_type,
              first_name,
              last_name,
              email,
              phone,
              status
            FROM account_applications
            WHERE id = $1
            FOR UPDATE
          `,
          [applicationId],
        )

        if (existing.rowCount !== 1) {
          await client.query('ROLLBACK')

          return res.status(404).json({
            ok: false,
            error: 'Application not found.',
          })
        }

        const application = existing.rows[0]

        if (
          application.status === 'approved' ||
          application.status === 'rejected' ||
          application.status === 'cancelled'
        ) {
          await client.query('ROLLBACK')

          return res.status(409).json({
            ok: false,
            error: 'This application has already reached a final status.',
          })
        }

        const allowedTransitions: Record<string, string[]> = {
          pending: ['under_review', 'approved', 'rejected', 'cancelled'],
          under_review: ['approved', 'rejected', 'cancelled'],
        }

        if (!allowedTransitions[application.status]?.includes(status)) {
          await client.query('ROLLBACK')

          return res.status(409).json({
            ok: false,
            error: `Application cannot move from ${application.status} to ${status}.`,
          })
        }

        if (status === 'approved') {
          let customerId = application.customer_id

          if (!customerId) {
            const existingCustomer = await client.query(
              `
                SELECT id
                FROM customers
                WHERE LOWER(email) = LOWER($1)
                LIMIT 1
              `,
              [application.email],
            )

            if (existingCustomer.rowCount === 1) {
              customerId = existingCustomer.rows[0].id
            }
          }

          if (!customerId) {
            await client.query('ROLLBACK')

            return res.status(409).json({
              ok: false,
              error:
                'This application has no existing customer account. Create the customer account through the approved onboarding flow before approving it.',
            })
          }

          const lockedCustomer = await client.query(
            `
              SELECT id, status, role
              FROM customers
              WHERE id = $1
              FOR UPDATE
            `,
            [customerId],
          )

          if (lockedCustomer.rowCount !== 1) {
            await client.query('ROLLBACK')
            return res.status(409).json({
              ok: false,
              error: 'The customer record could not be found.',
            })
          }

          const customer = lockedCustomer.rows[0]

          if (customer.role !== 'customer') {
            await client.query('ROLLBACK')
            return res.status(409).json({
              ok: false,
              error: 'Only customer accounts can be approved through this workflow.',
            })
          }

          if (!['pending', 'active'].includes(customer.status)) {
            await client.query('ROLLBACK')
            return res.status(409).json({
              ok: false,
              error: 'This customer is not eligible for activation.',
            })
          }

          const existingAccount = await client.query(
            `
              SELECT account_number
              FROM accounts
              WHERE customer_id = $1
                AND account_type = $2
                AND status <> 'closed'
              LIMIT 1
            `,
            [customerId, application.account_type],
          )

          if (existingAccount.rowCount === 1) {
            await client.query('ROLLBACK')

            return res.status(409).json({
              ok: false,
              error:
                'This customer already has an active or pending account of the requested type.',
            })
          }

          const accountNumber = await generateAccountNumber(client)

          await client.query(
            `
              INSERT INTO accounts (
                customer_id,
                account_number,
                account_type,
                status,
                currency,
                available_balance,
                current_balance
              )
              VALUES ($1, $2, $3, 'active', 'USD', 0, 0)
            `,
            [
              customerId,
              accountNumber,
              application.account_type,
            ],
          )

          if (customer.status === 'pending') {
            const activated = await client.query(
              `
                UPDATE customers
                SET status = 'active',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND status = 'pending'
              `,
              [customerId],
            )

            if (activated.rowCount !== 1) {
              throw new Error('Customer activation failed during approval.')
            }
          }

          await client.query(
            `
              UPDATE account_applications
              SET
                customer_id = $1,
                status = 'approved',
                review_notes = $2,
                reviewed_by = $3,
                reviewed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = $4
            `,
            [
              customerId,
              reviewNotes,
              user.id,
              applicationId,
            ],
          )
        } else {
          await client.query(
            `
              UPDATE account_applications
              SET
                status = $1,
                review_notes = $2,
                reviewed_by = $3,
                reviewed_at = CASE
                  WHEN $4 IN ('rejected', 'cancelled')
                    THEN CURRENT_TIMESTAMP
                  ELSE reviewed_at
                END,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = $5
            `,
            [
              status,
              reviewNotes,
              user.id,
              status,
              applicationId,
            ],
          )
        }

        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      await writeStaffAuditLog(
        req,
        user.id,
        `application.${status}`,
        'account_application',
        applicationId,
        `Account application ${status} by management user.`,
        {
          applicationId,
          status,
          reviewNotes,
        },
      )

      return res.status(200).json({
        ok: true,
        message: `Application ${status}.`,
      })
    }

    res.setHeader('Allow', 'GET, PATCH')

    return res.status(405).json({
      ok: false,
      error: 'Method not allowed',
    })
  } catch (error) {
    console.error('Management applications failed:', error)

    return res.status(500).json({
      ok: false,
      error: 'Unable to process management application request.',
    })
  }
}

async function generateAccountNumber(
  client: {
    query: (
      text: string,
      values?: unknown[],
    ) => Promise<{ rows: Array<Record<string, unknown>> }>
  },
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate =
      `40${randomInt(1000000000, 10000000000)}`

    const result = await client.query(
      `
        SELECT 1
        FROM accounts
        WHERE account_number = $1
        LIMIT 1
      `,
      [candidate],
    )

    if (result.rows.length === 0) {
      return candidate
    }
  }

  throw new Error('Unable to generate a unique account number.')
}
