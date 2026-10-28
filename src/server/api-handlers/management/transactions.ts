import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getDb } from '../../db/client.js'
import { sendTransactionNotification } from '../../email/transaction-notifications.js'
import { requirePermission } from '../../auth/management.js'

function error(response: VercelResponse, status: number, message: string) {
  return response.status(status).json({ ok: false, error: message })
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method === 'PATCH') {
    const manager = await requirePermission(request, 'transactions.view')
    if (!manager || manager.role !== 'super_manager') {
      return error(response, 403, 'Only the Super Manager can review deposits.')
    }

    const body = request.body && typeof request.body === 'object'
      ? request.body as Record<string, unknown>
      : {}
    const transactionId = typeof body.transactionId === 'string' ? body.transactionId.trim() : ''
    const action = body.action
    if (!transactionId || !['approve', 'reject'].includes(String(action))) {
      return error(response, 400, 'A transaction ID and valid review action are required.')
    }

    const db = getDb()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const found = await client.query(
        `SELECT t.id, t.reference, t.transaction_type, t.status, t.amount,
                t.currency, t.description, t.account_id, a.status AS account_status, a.account_number,
                c.id AS customer_id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN customers c ON c.id = a.customer_id
         WHERE t.id::text = $1
         FOR UPDATE OF t, a`,
        [transactionId],
      )
      if (found.rowCount !== 1) {
        await client.query('ROLLBACK')
        return error(response, 404, 'Transaction not found.')
      }

      const tx = found.rows[0]
      if (tx.transaction_type !== 'deposit' || tx.status !== 'pending') {
        await client.query('ROLLBACK')
        return error(response, 409, 'Only pending deposits can be reviewed.')
      }

      if (action === 'approve' && tx.account_status !== 'active') {
        await client.query('ROLLBACK')
        return error(response, 409, 'The account must be active before approval.')
      }

      if (action === 'approve') {
        const balanceUpdate = await client.query(
          `UPDATE accounts
           SET available_balance = available_balance + $1,
               current_balance = current_balance + $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [tx.amount, tx.account_id],
        )
        if (balanceUpdate.rowCount !== 1) {
          throw new Error('Deposit approval did not update exactly one account.')
        }
      }

      const nextStatus = action === 'approve' ? 'completed' : 'failed'
      await client.query(
        `UPDATE transactions
         SET status = $1
         WHERE id = $2`,
        [nextStatus, tx.id],
      )
      await client.query('COMMIT')

      // Best-effort email after the review is committed.
      await sendTransactionNotification({
        customerId: tx.customer_id,
        type: 'deposit',
        reference: tx.reference,
        amount: tx.amount,
        currency: tx.currency,
        status: nextStatus,
        accountNumber: tx.account_number,
        description: action === 'approve'
          ? 'Your deposit was approved.'
          : 'Your deposit was rejected.',
      })

      try {
        const { writeStaffAuditLog } = await import('../../auth/audit.js')
        await writeStaffAuditLog(
          request, manager.id, action === "approve" ? "deposit.approved" : "deposit.rejected", 'transaction', tx.id,
          `Deposit ${tx.reference} was ${action === "approve" ? "approved" : "rejected"}.`,
          { reference: tx.reference, amount: String(tx.amount),
            accountNumber: tx.account_number },
        )
      } catch (auditError) {
        console.error('Deposit review audit logging failed:', auditError)
      }

      try {
        await sendTransactionNotification({
          customerId: String(tx.customer_id),
          type: 'deposit',
          reference: String(tx.reference),
          amount: Number(tx.amount),
          currency: String(tx.currency),
          status: nextStatus,
          accountNumber: String(tx.account_number),
          description: String(tx.description ||
            (action === 'approve' ? 'Deposit approved' : 'Deposit rejected')),
        })
      } catch (emailError) {
        console.error('Deposit review email notification failed:', emailError)
      }

      return response.status(200).json({ ok: true, status: nextStatus })
    } catch (reviewError) {
      await client.query('ROLLBACK')
      console.error('Deposit review failed:', reviewError)
      return error(response, 500, 'Unable to review deposit.')
    } finally {
      client.release()
    }
  }

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET, PATCH')
    return error(response, 405, 'Method not allowed.')
  }

  const managementUser = await requirePermission(request, 'transactions.view')

  if (!managementUser) {
    return error(response, 403, 'You do not have permission to view transactions.')
  }

  const db = getDb()

  const search =
    typeof request.query.search === 'string'
      ? request.query.search.trim()
      : ''

  const values: unknown[] = []
  let where = ''

  if (search) {
    values.push(`%${search}%`)
    const parameter = `$${values.length}`

    where = `
      WHERE
        t.reference LIKE ${parameter}
        OR t.description LIKE ${parameter}
        OR a.account_number LIKE ${parameter}
        OR c.customer_number LIKE ${parameter}
        OR c.first_name LIKE ${parameter}
        OR c.last_name LIKE ${parameter}
    `
  }

  const result = await db.query(
    `
      SELECT
        t.id,
        t.reference,
        t.transaction_type,
        t.status,
        t.amount,
        t.currency,
        t.description,
        t.created_at,
        a.account_number,
        a.account_type,
        c.customer_number,
        c.first_name,
        c.last_name
      FROM transactions t
      INNER JOIN accounts a
        ON a.id = t.account_id
      INNER JOIN customers c
        ON c.id = a.customer_id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT 500
    `,
    values,
  )

  return response.status(200).json({
    ok: true,
    transactions: result.rows,
    viewer: managementUser.customer_number,
  })
}
