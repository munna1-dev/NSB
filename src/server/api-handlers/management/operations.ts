import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomUUID } from 'node:crypto'
import { getDb } from '../../db/client.js'
import { writeStaffAuditLog } from '../../auth/audit.js'
import {
  hasManagementPermission,
  requireAnyPermission,
  requirePermission,
  type ManagementPermission,
} from '../../auth/management.js'

function error(response: VercelResponse, status: number, message: string) {
  return response.status(status).json({ ok: false, error: message })
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method === 'GET') {
    const managementUser = await requireAnyPermission(request, [
      'transfers.view',
      'payments.view',
    ])

    if (!managementUser) {
      return error(
        response,
        403,
        'You do not have permission to access operations.',
      )
    }

    const canViewTransfers =
      await hasManagementPermission(managementUser, 'transfers.view')

    const canViewPayments =
      await hasManagementPermission(managementUser, 'payments.view')

    const db = getDb()

    const parts: string[] = []

    if (canViewTransfers) {
      parts.push(`
        SELECT
          'transfer' AS operation_type,
          t.id,
          t.status,
          t.amount,
          t.currency,
          t.description,
          t.created_at,
          a.account_number,
          c.customer_number,
          c.first_name,
          c.last_name
        FROM transfers t
        INNER JOIN accounts a
          ON a.id = t.from_account_id
        INNER JOIN customers c
          ON c.id = a.customer_id
      `)
    }

    if (canViewPayments) {
      parts.push(`
        SELECT
          'payment' AS operation_type,
          p.id,
          p.status,
          p.amount,
          p.currency,
          p.description,
          p.created_at,
          a.account_number,
          c.customer_number,
          c.first_name,
          c.last_name
        FROM payments p
        INNER JOIN accounts a
          ON a.id = p.account_id
        INNER JOIN customers c
          ON c.id = a.customer_id
      `)
    }

    if (parts.length === 0) {
      return error(
        response,
        403,
        'You do not have permission to access operations.',
      )
    }

    const result = await db.query(`
      ${parts.join('\nUNION ALL\n')}
      ORDER BY created_at DESC
      LIMIT 300
    `)

    return response.status(200).json({
      ok: true,
      operations: result.rows,
    })
  }

  if (request.method === 'PATCH') {
    const body =
      typeof request.body === 'object' && request.body !== null
        ? request.body as Record<string, unknown>
        : {}

    const operationType =
      typeof body.operationType === 'string'
        ? body.operationType.trim()
        : ''

    const operationId =
      typeof body.operationId === 'string'
        ? body.operationId.trim()
        : ''

    const status =
      typeof body.status === 'string'
        ? body.status.trim()
        : ''

    if (!['transfer', 'payment'].includes(operationType)) {
      return error(response, 400, 'Invalid operation type.')
    }

    if (!operationId) {
      return error(response, 400, 'Operation ID is required.')
    }

    if (!['completed', 'failed', 'cancelled'].includes(status)) {
      return error(response, 400, 'Invalid operation status.')
    }

    const permission: ManagementPermission =
      operationType === 'payment'
        ? status === 'completed'
          ? 'payments.approve'
          : 'payments.reject'
        : status === 'completed'
          ? 'transfers.approve'
          : 'transfers.reject'

    const managementUser = await requirePermission(request, permission)

    if (!managementUser) {
      return error(
        response,
        403,
        'You do not have permission to change this operation.',
      )
    }

    /*
     * Customer-initiated internal transfers are already settled atomically
     * when created. Management must never debit/credit those transfers again.
     *
     * Pending transfers can therefore only have their workflow status
     * reviewed. Payment completion, however, is the financial settlement
     * point because customer payment creation intentionally records a
     * pending instruction without moving funds.
     */
    if (operationType === 'transfer' && status === 'completed') {
      return error(
        response,
        409,
        'Internal transfers are settled when created and cannot be completed again.',
      )
    }

    const table = operationType === 'transfer' ? 'transfers' : 'payments'
    const client = await getDb().connect()

    try {
      await client.query('BEGIN')

      const current = await client.query(
        `
          SELECT
            id,
            customer_id,
            ${operationType === 'payment' ? 'account_id,' : 'from_account_id,'}
            status,
            amount,
            currency,
            description,
            reference
          FROM ${table}
          WHERE id = $1
          FOR UPDATE
        `,
        [operationId],
      )

      if (current.rowCount !== 1) {
        await client.query('ROLLBACK')
        return error(response, 404, 'Operation not found.')
      }

      const operation = current.rows[0]

      if (operation.status !== 'pending') {
        await client.query('ROLLBACK')
        return error(
          response,
          409,
          'Only pending operations can be reviewed.',
        )
      }

      let transactionId: string | null = null

      if (operationType === 'payment' && status === 'completed') {
        const accountResult = await client.query(
          `
            SELECT
              id,
              customer_id,
              status,
              currency,
              available_balance,
              current_balance
            FROM accounts
            WHERE id = $1
            FOR UPDATE
          `,
          [operation.account_id],
        )

        if (accountResult.rowCount !== 1) {
          await client.query('ROLLBACK')
          return error(response, 404, 'Payment account not found.')
        }

        const account = accountResult.rows[0]
        const amount = Number(operation.amount)
        const availableBalance = Number(account.available_balance)

        if (account.customer_id !== operation.customer_id) {
          await client.query('ROLLBACK')
          return error(
            response,
            409,
            'Payment account ownership could not be verified.',
          )
        }

        if (account.status !== 'active') {
          await client.query('ROLLBACK')
          return error(
            response,
            409,
            'The payment account is not active.',
          )
        }

        if (account.currency !== operation.currency) {
          await client.query('ROLLBACK')
          return error(
            response,
            409,
            'Payment currency does not match the account currency.',
          )
        }

        if (!Number.isFinite(amount) || amount <= 0) {
          await client.query('ROLLBACK')
          return error(
            response,
            409,
            'Payment amount is invalid.',
          )
        }

        if (availableBalance < amount) {
          await client.query('ROLLBACK')
          return error(
            response,
            409,
            'The payment cannot be completed because available funds are insufficient.',
          )
        }

        transactionId = randomUUID()

        await client.query(
          `
            INSERT INTO transactions (
              id,
              account_id,
              reference,
              transaction_type,
              status,
              description,
              amount,
              currency,
              metadata
            )
            VALUES (
              $1,
              $2,
              $3,
              'payment',
              'completed',
              $4,
              $5,
              $6,
              $7
            )
          `,
          [
            transactionId,
            account.id,
            `NS-TXN-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
            operation.description ||
              `Payment to ${operation.reference}`,
            -amount,
            operation.currency,
            JSON.stringify({
              paymentId: operation.id,
              paymentReference: operation.reference,
              operation: 'management.payment.completed',
            }),
          ],
        )

        await client.query(
          `
            UPDATE accounts
            SET
              available_balance = available_balance - $1,
              current_balance = current_balance - $1,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `,
          [amount, account.id],
        )
      }

      const updated = await client.query(
        `
          UPDATE ${table}
          SET
            status = $1,
            completed_at = CASE
              WHEN $1::varchar = 'completed' THEN CURRENT_TIMESTAMP
              ELSE completed_at
            END
          WHERE id = $2
            AND status = 'pending'
          RETURNING *
        `,
        [status, operationId],
      )

      if (updated.rowCount !== 1) {
        throw new Error('Operation was changed by another reviewer.')
      }

        const display = await client.query(
          `
            SELECT
              '${operationType}' AS operation_type,
              o.id,
              o.status,
              o.amount,
              o.currency,
              o.description,
              o.created_at,
              a.account_number,
              c.customer_number,
              c.first_name,
              c.last_name
            FROM ${table} o
            INNER JOIN accounts a
              ON a.id = ${operationType === 'payment' ? 'o.account_id' : 'o.from_account_id'}
            INNER JOIN customers c
              ON c.id = a.customer_id
            WHERE o.id = $1
          `,
          [operationId],
        )

        if (display.rowCount !== 1) {
          throw new Error('Updated operation could not be loaded.')
        }

      await client.query('COMMIT')

      try {
        await writeStaffAuditLog(
          request,
          managementUser.id,
          `${operationType}.status_changed`,
          operationType,
          operationId,
          `${operationType} status changed from pending to ${status}.`,
          {
            previousStatus: operation.status,
            newStatus: status,
            amount: operation.amount,
            currency: operation.currency,
            reference: operation.reference,
            transactionId,
            settlement:
              operationType === 'payment' && status === 'completed',
          },
        )
      } catch (auditError) {
        console.error('Operation audit failed:', auditError)
      }

      return response.status(200).json({
        ok: true,
        operation: display.rows[0],
      })
    } catch (operationError) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original database error.
      }

      console.error('Management operation update failed:', operationError)

      return error(response, 500, 'Unable to update the operation.')
    } finally {
      client.release()
    }
  }

  response.setHeader('Allow', 'GET, PATCH')
  return error(response, 405, 'Method not allowed.')
}
