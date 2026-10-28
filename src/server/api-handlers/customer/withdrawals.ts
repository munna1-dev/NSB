import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { requireCustomer } from '../../auth/customer.js'
import { getDb } from '../../db/client.js'
import { sendTransactionNotification } from '../../email/transaction-notifications.js'

const schema = z.object({
  accountId: z.string().uuid(),
  amount: z.string().trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter a valid amount with up to 2 decimal places.')
    .refine((v) => Number(v) > 0 && Number.isFinite(Number(v)),
      'Amount must be greater than zero.'),
  description: z.string().trim().max(300).optional().default(''),
  idempotencyKey: z.string().uuid(),
})

function reference() {
  return `NS-WD-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed.' })
  }

  try {
    const customer = await requireCustomer(req)
    if (!customer) {
      return res.status(401).json({
        ok: false, authenticated: false, error: 'Not authenticated.',
      })
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const parsed = schema.safeParse({
      ...body,
      idempotencyKey: body.idempotencyKey ?? req.headers['idempotency-key'],
    })
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid withdrawal request.',
      })
    }

    const { accountId, amount, description, idempotencyKey } = parsed.data
    const db = getDb()
    const client = await db.connect()
    let inTransaction = false
    let notification: {
      customerId: string
      type: string
      reference: string
      amount: number
      currency: string
      status: string
      accountNumber: string
      description: string
    } | null = null

    try {
      await client.query('BEGIN')
      inTransaction = true

      // Lock only an account owned by this authenticated customer.
      const accountResult = await client.query(
        `SELECT id, account_number, status, currency,
                available_balance, current_balance,
                withdrawals_blocked, withdrawal_limit
         FROM accounts
         WHERE id::text = $1 AND customer_id::text = $2
         FOR UPDATE`,
        [accountId, String(customer.id)],
      )

      if (accountResult.rowCount !== 1) {
        await client.query('ROLLBACK')
        inTransaction = false
        return res.status(404).json({ ok: false, error: 'Account not found.' })
      }

      const account = accountResult.rows[0]

      // A retry returns the original withdrawal and never sends a second email.
      const prior = await client.query(
        `SELECT id, reference, amount, currency, status, description, created_at, metadata
         FROM transactions
         WHERE account_id::text = $1
           AND transaction_type = 'withdrawal'
           AND metadata->>'idempotencyKey' = $2
         LIMIT 1`,
        [accountId, idempotencyKey],
      )

      if (prior.rowCount) {
        const tx = prior.rows[0]
        const sameRequest =
          Math.abs(Math.abs(Number(tx.amount)) - Number(amount)) < 0.000001 &&
          String(tx.metadata?.description ?? '') === description

        if (!sameRequest) {
          await client.query('ROLLBACK')
          inTransaction = false
          return res.status(409).json({
            ok: false, error: 'Idempotency key was used for a different withdrawal.',
          })
        }

        await client.query('COMMIT')
        inTransaction = false
        return res.status(200).json({
          ok: true, idempotent: true,
          withdrawal: {
            id: tx.id, reference: tx.reference, status: tx.status,
            amount: Math.abs(Number(tx.amount)), currency: tx.currency,
            description: tx.description, createdAt: tx.created_at,
          },
        })
      }

      if (String(account.status).toLowerCase() !== 'active') {
        await client.query('ROLLBACK')
        inTransaction = false
        return res.status(409).json({
          ok: false, error: 'This account is not active.',
        })
      }

      if (account.withdrawals_blocked === true) {
        await client.query('ROLLBACK')
        inTransaction = false
        return res.status(403).json({
          ok: false, error: 'Withdrawals are restricted on this account.',
        })
      }

      if (
        account.withdrawal_limit !== null &&
        account.withdrawal_limit !== undefined &&
        Number(amount) > Number(account.withdrawal_limit)
      ) {
        await client.query('ROLLBACK')
        inTransaction = false
        return res.status(409).json({
          ok: false,
          error: `This account has a maximum withdrawal limit of ${account.withdrawal_limit}.`,
        })
      }

      // Numeric comparisons and updates are performed by PostgreSQL.
      const balanceCheck = await client.query(
        `SELECT available_balance >= $1::numeric AS has_available,
                current_balance >= $1::numeric AS has_current
         FROM accounts WHERE id = $2`,
        [amount, accountId],
      )

      if (!balanceCheck.rows[0]?.has_available || !balanceCheck.rows[0]?.has_current) {
        await client.query('ROLLBACK')
        inTransaction = false
        return res.status(409).json({
          ok: false, error: 'Insufficient available balance.',
        })
      }

      const ref = reference()
      const memo = description || 'Customer withdrawal'

      const debit = await client.query(
        `UPDATE accounts
         SET available_balance = available_balance - $1::numeric,
             current_balance = current_balance - $1::numeric,
             updated_at = NOW()
         WHERE id = $2
           AND available_balance >= $1::numeric
           AND current_balance >= $1::numeric
         RETURNING available_balance, current_balance`,
        [amount, accountId],
      )

      if (debit.rowCount !== 1) {
        await client.query('ROLLBACK')
        inTransaction = false
        return res.status(409).json({
          ok: false, error: 'Balance changed; refresh and try again.',
        })
      }

      const inserted = await client.query(
        `INSERT INTO transactions (
           account_id, reference, transaction_type, status,
           description, amount, currency, metadata
         )
         VALUES ($1, $2, 'withdrawal', 'completed', $3, -$4::numeric, $5, $6::jsonb)
         RETURNING id, reference, status, amount, currency, description, created_at`,
        [
          accountId, ref, memo, amount, account.currency,
          JSON.stringify({
            idempotencyKey,
            description,
            channel: 'customer_api',
          }),
        ],
      )

      const tx = inserted.rows[0]
      await client.query('COMMIT')
      inTransaction = false

      notification = {
        customerId: String(customer.id),
        type: 'Withdrawal',
        reference: tx.reference,
        amount: Number(amount),
        currency: String(account.currency),
        status: 'completed',
        accountNumber: String(account.account_number),
        description: memo,
      }

      // Email is best-effort and must never undo a committed withdrawal.
      try {
        await sendTransactionNotification(notification)
      } catch (emailError) {
        console.error('Withdrawal email notification failed:', emailError)
      }

      return res.status(201).json({
        ok: true,
        withdrawal: {
          id: tx.id,
          reference: tx.reference,
          status: tx.status,
          amount: Number(amount),
          currency: tx.currency,
          description: tx.description,
          createdAt: tx.created_at,
        },
        balances: {
          availableBalance: Number(debit.rows[0].available_balance),
          currentBalance: Number(debit.rows[0].current_balance),
        },
      })
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK') } catch {}
      }
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Customer withdrawal failed:', error)
    return res.status(500).json({
      ok: false, error: 'Unable to process withdrawal.',
    })
  }
}
