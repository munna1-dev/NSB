import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getDb } from '../../db/client.js'
import { sendTransactionNotification } from '../../email/transaction-notifications.js'
import { writeStaffAuditLog } from '../../auth/audit.js'
import { requirePermission } from '../../auth/management.js'

const ACCOUNT_STATUSES = ['active', 'pending', 'frozen', 'closed'] as const

function error(response: VercelResponse, status: number, message: string) {
  return response.status(status).json({ ok: false, error: message })
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  const db = getDb()

  // SUPER_MANAGER_DEPOSIT_PATCH
  if (request.method === 'POST') {
    const manager = await requirePermission(request, 'accounts.view')
    if (!manager || manager.role !== 'super_manager') {
      return error(response, 403, 'Only the Super Manager can post deposits.')
    }

    const body = request.body && typeof request.body === 'object'
      ? request.body as Record<string, unknown>
      : {}
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : ''
    const amountText = String(body.amount ?? '').trim()
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''

    if (!accountId || !/^\d+(?:\.\d{1,2})?$/.test(amountText) ||
        !key || key.length > 100 || !description || description.length > 300) {
      return error(response, 400, 'Enter a valid account, positive amount and description.')
    }

    const amount = Number(amountText)
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) {
      return error(response, 400, 'Deposit amount is outside the allowed range.')
    }

    const safeKey = key.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 55)
    if (!safeKey) {
      return error(response, 400, 'The deposit idempotency key is invalid.')
    }
    const reference = `DEP-${safeKey}`
    const client = await db.connect()
    try {
      await client.query('BEGIN')

      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [reference])
      const previous = await client.query(
        `SELECT id, reference, account_id, amount, transaction_type
         FROM transactions WHERE reference = $1 LIMIT 1`,
        [reference],
      )
      if (previous.rowCount) {
        const existing = previous.rows[0]
        await client.query('COMMIT')
        if (
          String(existing.account_id) !== accountId ||
          Number(existing.amount) !== amount ||
          existing.transaction_type !== 'deposit'
        ) {
          return error(response, 409, 'This deposit key was already used for a different deposit.')
        }
        return response.status(200).json({
          ok: true, duplicate: true, reference: existing.reference,
        })
      }

      const found = await client.query(
        `SELECT a.id, a.account_number, a.status, a.currency,
                c.customer_number, c.role, c.id AS customer_id
         FROM accounts a
         JOIN customers c ON c.id = a.customer_id
         WHERE a.id::text = $1
         FOR UPDATE OF a`,
        [accountId],
      )
      if (found.rowCount !== 1) {
        await client.query('ROLLBACK')
        return error(response, 404, 'Customer account not found.')
      }

      const account = found.rows[0]
      if (account.status !== 'active' ||
          account.role === 'management' || account.role === 'developer') {
        await client.query('ROLLBACK')
        return error(response, 409, 'This account cannot receive a deposit.')
      }

      await client.query(
        `UPDATE accounts
         SET available_balance = available_balance + $1,
             current_balance = current_balance + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [amount.toFixed(2), account.id],
      )

      await client.query(
        `INSERT INTO transactions
           (account_id, reference, transaction_type, status, description,
            amount, currency, metadata)
         VALUES ($1, $2, 'deposit', 'completed', $3, $4, $5, $6)`,
        [account.id, reference, description, amount.toFixed(2), account.currency,
         JSON.stringify({ source: 'management_manual_deposit', actorStaffId: manager.id })],
      )

      await client.query('COMMIT')

      await sendTransactionNotification({
        customerId: account.customer_id,
        type: 'deposit',
        reference,
        amount,
        currency: account.currency,
        status: 'completed',
        accountNumber: account.account_number,
        description,
      })

      try {
        await writeStaffAuditLog(
          request, manager.id, 'deposit.posted', 'account', account.id,
          `Manual deposit posted to account ${account.account_number}.`,
          { reference, amount: amount.toFixed(2), currency: account.currency,
            customerNumber: account.customer_number },
        )
      } catch (auditError) {
        console.error('Deposit audit logging failed:', auditError)
      }

      return response.status(201).json({ ok: true, reference })
    } catch (depositError) {
      await client.query('ROLLBACK')
      console.error('Management deposit failed:', depositError)
      return error(response, 500, 'Unable to post deposit.')
    } finally {
      client.release()
    }
  }

  // WITHDRAWAL_CONTROLS_PATCH_V1
  if (request.method === 'PATCH' &&
      request.body?.action === 'withdrawal_controls') {
    const manager = await requirePermission(request, 'accounts.view')
    if (!manager || manager.role !== 'super_manager') {
      return error(response, 403, 'Only the Super Manager can change withdrawal controls.')
    }

    const body = request.body as Record<string, unknown>
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : ''
    const blocked = body.withdrawalsBlocked
    const limitText = body.withdrawalLimit

    if (!accountId || typeof blocked !== 'boolean') {
      return error(response, 400, 'Account and withdrawal-block setting are required.')
    }

    let limit: string | null = null
    if (limitText !== null && limitText !== undefined && String(limitText).trim() !== '') {
      const text = String(limitText).trim()
      if (!/^\\d+(?:\\.\\d{1,2})?$/.test(text)) {
        return error(response, 400, 'Maximum withdrawal must be a valid amount with up to two decimals.')
      }
      const amount = Number(text)
      if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) {
        return error(response, 400, 'Maximum withdrawal must be between 0 and 1,000,000,000.')
      }
      limit = amount.toFixed(2)
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const found = await client.query(
        `SELECT a.id, a.account_number, a.withdrawals_blocked, a.withdrawal_limit,
                c.role
         FROM accounts a
         INNER JOIN customers c ON c.id = a.customer_id
         WHERE a.id::text = $1
         FOR UPDATE OF a`,
        [accountId],
      )

      if (found.rowCount !== 1) {
        await client.query('ROLLBACK')
        return error(response, 404, 'Account not found.')
      }

      const account = found.rows[0]
      if (account.role === 'management' || account.role === 'developer') {
        await client.query('ROLLBACK')
        return error(response, 403, 'Staff accounts cannot be changed through customer withdrawal controls.')
      }

      const updated = await client.query(
        `UPDATE accounts
         SET withdrawals_blocked = $1,
             withdrawal_limit = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING id, account_number, withdrawals_blocked, withdrawal_limit`,
        [blocked, limit, account.id],
      )
      await client.query('COMMIT')

      try {
        await writeStaffAuditLog(
          request, manager.id, 'account.withdrawal_controls_updated',
          'account', account.id,
          `Withdrawal controls updated for account ${account.account_number}.`,
          {
            previous: {
              withdrawalsBlocked: account.withdrawals_blocked,
              withdrawalLimit: account.withdrawal_limit === null ? null : String(account.withdrawal_limit),
            },
            current: {
              withdrawalsBlocked: blocked,
              withdrawalLimit: limit,
            },
          },
        )
      } catch (auditError) {
        console.error('Withdrawal controls audit logging failed:', auditError)
      }

      return response.status(200).json({ ok: true, account: updated.rows[0] })
    } catch (controlError) {
      try { await client.query('ROLLBACK') } catch {}
      console.error('Updating withdrawal controls failed:', controlError)
      return error(response, 500, 'Unable to update withdrawal controls.')
    } finally {
      client.release()
    }
  }

  const requestedStatus = String(request.body?.status ?? '').trim()

  if (
    request.method !== 'GET' &&
    !['active', 'frozen', 'closed'].includes(requestedStatus)
  ) {
    return error(response, 400, 'This account action is not supported.')
  }

  const managementUser =
    request.method === 'GET'
      ? await requirePermission(request, 'accounts.view')
      : await requirePermission(
          request,
          requestedStatus === 'active'
            ? 'accounts.activate'
            : requestedStatus === 'frozen'
              ? 'accounts.freeze'
              : 'accounts.close',
        )

  if (!managementUser) {
    return error(response, 403, 'You do not have permission to perform this account action.')
  }

  if (request.method === 'GET') {
    const status =
      typeof request.query.status === 'string'
        ? request.query.status.trim()
        : ''

    const search =
      typeof request.query.search === 'string'
        ? request.query.search.trim()
        : ''

    if (
      status &&
      !ACCOUNT_STATUSES.includes(
        status as typeof ACCOUNT_STATUSES[number],
      )
    ) {
      return error(response, 400, 'Invalid account status filter.')
    }

    const values: unknown[] = []
    const conditions: string[] = []

    if (status) {
      values.push(status)
      conditions.push(`a.status = $${values.length}`)
    }

    if (search) {
      values.push(`%${search}%`)
      const parameter = `$${values.length}`

      conditions.push(`
        (
          a.account_number LIKE ${parameter}
          OR c.customer_number LIKE ${parameter}
          OR c.first_name LIKE ${parameter}
          OR c.last_name LIKE ${parameter}
          OR c.email LIKE ${parameter}
        )
      `)
    }

    const where =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : ''

    const result = await db.query(
      `
        SELECT
          a.id,
          a.account_number,
          a.account_type,
          a.status,
          a.currency,
          a.available_balance,
          a.current_balance,
          a.withdrawals_blocked,
          a.withdrawal_limit,
          a.created_at,
          a.updated_at,
          c.id AS customer_id,
          c.customer_number,
          c.first_name,
          c.last_name,
          c.email
        FROM accounts a
        INNER JOIN customers c
          ON c.id = a.customer_id
        ${where}
        ORDER BY a.created_at DESC
        LIMIT 300
      `,
      values,
    )

    return response.status(200).json({
      ok: true,
      accounts: result.rows,
    })
  }

  if (request.method === 'PATCH') {
    const body =
      typeof request.body === 'object' && request.body !== null
        ? request.body as Record<string, unknown>
        : {}

    const accountId =
      typeof body.accountId === 'string'
        ? body.accountId.trim()
        : ''

    const status =
      typeof body.status === 'string'
        ? body.status.trim()
        : ''

    if (!accountId) {
      return error(response, 400, 'Account ID is required.')
    }

    if (
      !ACCOUNT_STATUSES.includes(
        status as typeof ACCOUNT_STATUSES[number],
      )
    ) {
      return error(response, 400, 'Invalid account status.')
    }

    const client = await db.connect()

    try {
      await client.query('BEGIN')

      const accountResult = await client.query(
        `
          SELECT
            a.id,
            a.account_number,
            a.status,
            a.account_type,
            c.customer_number,
            c.role
          FROM accounts a
          INNER JOIN customers c
            ON c.id = a.customer_id
          WHERE a.id = $1
          FOR UPDATE OF a
        `,
        [accountId],
      )

      if (accountResult.rowCount !== 1) {
        await client.query('ROLLBACK')
        return error(response, 404, 'Account not found.')
      }

      const account = accountResult.rows[0]

      if (
        account.role === 'management' ||
        account.role === 'developer'
      ) {
        await client.query('ROLLBACK')
        return error(
          response,
          403,
          'Management staff accounts cannot be changed through account controls.',
        )
      }

      if (account.status === 'closed' && status !== 'closed') {
        await client.query('ROLLBACK')
        return error(
          response,
          409,
          'A closed account cannot be reopened through this control.',
        )
      }

      if (account.status === status) {
        await client.query('ROLLBACK')
        return response.status(200).json({
          ok: true,
          account,
        })
      }

      const updated = await client.query(
        `
          UPDATE accounts
          SET
            status = $1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          RETURNING
            id,
            account_number,
            account_type,
            status,
            currency,
            available_balance,
            current_balance,
            created_at,
            updated_at
        `,
        [status, accountId],
      )

      await client.query('COMMIT')

      try {
        await writeStaffAuditLog(
          request,
          managementUser.id,
          'account.status_changed',
          'account',
          accountId,
          `Account ${account.account_number} status changed from ${account.status} to ${status}.`,
          {
            accountNumber: account.account_number,
            customerNumber: account.customer_number,
            previousStatus: account.status,
            newStatus: status,
          },
        )
      } catch (auditError) {
        console.error('Account status audit failed:', auditError)
      }

      return response.status(200).json({
        ok: true,
        account: updated.rows[0],
      })
    } catch (updateError) {
      await client.query('ROLLBACK')
      console.error('Management account update failed:', updateError)

      return error(response, 500, 'Unable to update the account.')
    } finally {
      client.release()
    }
  }

  response.setHeader('Allow', 'GET, POST, PATCH')
  return error(response, 405, 'Method not allowed.')
}
