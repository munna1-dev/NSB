import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { requireCustomer } from '../../auth/customer.js'
import { getDb } from '../../db/client.js'

const paymentSchema = z.object({
  accountId: z.string().uuid('Invalid source account.'),
  payeeName: z
    .string()
    .trim()
    .min(2, 'Enter a payee name.')
    .max(200, 'Payee name is too long.'),
  payeeReference: z
    .string()
    .trim()
    .max(200, 'Payee reference is too long.')
    .optional()
    .default(''),
  amount: z
    .string()
    .trim()
    .regex(
      /^\d+(\.\d{1,2})?$/,
      'Enter a valid amount with up to 2 decimal places.',
    )
    .refine(
      (value) => Number(value) > 0,
      'Payment amount must be greater than zero.',
    ),
  currency: z
    .string()
    .trim()
    .min(3)
    .max(10)
    .default('USD'),
  scheduledFor: z
    .string()
    .trim()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      'Enter a valid payment date.',
    ),
  description: z
    .string()
    .trim()
    .max(500, 'Memo is too long.')
    .optional()
    .default(''),
  idempotencyKey: z.string().uuid('Invalid idempotency key.'),
})

function requestIp(req: VercelRequest): string | null {
  const forwarded = req.headers['x-forwarded-for']

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() || null
  }

  return typeof req.socket?.remoteAddress === 'string'
    ? req.socket.remoteAddress
    : null
}

function makeReference(): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).slice(2, 10).toUpperCase()

  return `NS-PAY-${timestamp}-${random}`
}

function isValidCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number)

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false
  }

  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function matchesPaymentRequest(
  payment: Record<string, unknown>,
  request: {
    accountId: string;
    payeeName: string;
    payeeReference: string;
    amount: string;
    currency: string;
    scheduledFor: string;
    description: string;
  },
): boolean {
  const storedDate = payment.scheduled_for instanceof Date
    ? payment.scheduled_for.toISOString().slice(0, 10)
    : String(payment.scheduled_for ?? '').slice(0, 10);

  return String(payment.account_id) === request.accountId
    && payment.payee_name === request.payeeName
    && (payment.payee_reference ?? '') === request.payeeReference
    && Number(payment.amount) === Number(request.amount)
    && payment.currency === request.currency
    && storedDate === request.scheduledFor
    && (payment.description ?? '') === request.description;
}

function paymentResponse(payment: Record<string, unknown>) {
  return {
    id: payment.id,
    reference: payment.reference,
    status: payment.status,
    payeeName: payment.payee_name,
    payeeReference: payment.payee_reference,
    amount: Number(payment.amount),
    currency: payment.currency,
    description: payment.description,
    scheduledFor: payment.scheduled_for,
    createdAt: payment.created_at,
    completedAt: payment.completed_at,
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')

    return res.status(405).json({
      ok: false,
      error: 'Method not allowed',
    })
  }

  try {
    const customer = await requireCustomer(req)

    if (!customer) {
      return res.status(401).json({
        ok: false,
        authenticated: false,
        error: 'Not authenticated.',
      })
    }

    const body = (req.body ?? {}) as Record<string, unknown>

    const parsed = paymentSchema.safeParse({
      ...body,
      idempotencyKey:
        body.idempotencyKey ?? req.headers['idempotency-key'],
    })

    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error:
          parsed.error.issues[0]?.message ??
          'Invalid payment request.',
      })
    }

    const {
      accountId,
      payeeName,
      payeeReference,
      amount,
      currency,
      scheduledFor,
      description,
      idempotencyKey,
    } = parsed.data

    if (!isValidCalendarDate(scheduledFor)) {
      return res.status(400).json({
        ok: false,
        error: 'The payment date is not a valid calendar date.',
      })
    }

    if (scheduledFor < todayUtc()) {
      return res.status(400).json({
        ok: false,
        error: 'The payment date cannot be in the past.',
      })
    }

    const db = getDb()
    const client = await db.connect()

    try {
      await client.query('BEGIN')

      /*
       * Idempotency is checked before creating a new payment so a client
       * retry returns the original operation instead of creating a duplicate.
       */
      const existingPayment = await client.query(
        `
          SELECT
            id,
            account_id,
            reference,
            status,
            payee_name,
            payee_reference,
            amount,
            currency,
            description,
            scheduled_for,
            created_at,
            completed_at
          FROM payments
          WHERE customer_id = $1
            AND idempotency_key = $2
          LIMIT 1
        `,
        [customer.id, idempotencyKey],
      )

      if (existingPayment.rowCount === 1) {
        const existing = existingPayment.rows[0]
        if (!matchesPaymentRequest(existing, {
          accountId, payeeName, payeeReference, amount,
          currency, scheduledFor, description,
        })) {
          await client.query('ROLLBACK')
          return res.status(409).json({
          ok: false,
          error: 'Idempotency key was already used for a different request.',
        })
        }

        await client.query('COMMIT')
        return res.status(200).json({
          ok: true,
          idempotent: true,
          payment: paymentResponse(existing),
        })
      }

      /*
       * Lock the source account so the balance being checked cannot change
       * concurrently while this payment instruction is being created.
       */
      const accountResult = await client.query(
        `
          SELECT
            id,
            customer_id,
            account_number,
            account_type,
            status,
            currency,
            available_balance,
            current_balance
          FROM accounts
          WHERE id = $1
          FOR UPDATE
        `,
        [accountId],
      )

      if (accountResult.rowCount !== 1) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          ok: false,
          error: 'The selected account could not be found.',
        })
      }

      const account = accountResult.rows[0]

      if (account.customer_id !== customer.id) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          ok: false,
          error: 'You can only make payments from your own accounts.',
        })
      }

      if (account.status !== 'active') {
        await client.query('ROLLBACK')

        return res.status(409).json({
          ok: false,
          error: 'The selected account is not active.',
        })
      }

      if (account.currency !== currency) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          ok: false,
          error: `This account uses ${account.currency}.`,
        })
      }

      const balanceCheck = await client.query(
        `
          SELECT
            ($1::numeric <= $2::numeric) AS sufficient
        `,
        [amount, String(account.available_balance)],
      )

      if (!balanceCheck.rows[0]?.sufficient) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          ok: false,
          error: 'The payment amount exceeds the available balance.',
        })
      }

      /*
       * This application does not yet have an external bill-payment rail.
       * Therefore the payment is recorded as a pending instruction rather
       * than falsely marking an external bill as settled.
       */
      const paymentReference = makeReference()

      const paymentResult = await client.query(
        `
          INSERT INTO payments (
            customer_id,
            account_id,
            payee_name,
            payee_reference,
            amount,
            currency,
            description,
            status,
            reference,
            scheduled_for,
            idempotency_key
          )
          VALUES (
            $1,
            $2,
            $3,
            NULLIF($4, ''),
            $5,
            $6,
            NULLIF($7, ''),
            'pending',
            $8,
            $9,
            $10
          )
          RETURNING
            id,
            account_id,
            reference,
            status,
            payee_name,
            payee_reference,
            amount,
            currency,
            description,
            scheduled_for,
            created_at,
            completed_at
        `,
        [
          customer.id,
          accountId,
          payeeName,
          payeeReference,
          amount,
          currency,
          description,
          paymentReference,
          scheduledFor,
          idempotencyKey,
        ],
      )

      const payment = paymentResult.rows[0]

      await client.query(
        `
          INSERT INTO audit_logs (
            actor_customer_id,
            action,
            resource_type,
            resource_id,
            description,
            ip_address,
            user_agent,
            metadata
          )
          VALUES (
            $1,
            'customer.payment.created',
            'payment',
            $2,
            $3,
            $4,
            $5,
            $6
          )
        `,
        [
          customer.id,
          payment.id,
          `Payment instruction ${payment.reference} created.`,
          requestIp(req),
          req.headers['user-agent'] ?? null,
          JSON.stringify({
            paymentReference: payment.reference,
            accountId,
            payeeName,
            payeeReference: payeeReference || null,
            amount,
            currency,
            scheduledFor,
            status: 'pending',
          }),
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        ok: true,
        idempotent: false,
        payment: paymentResponse(payment),
      })
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original database error.
      }

      /*
       * The unique idempotency index protects against concurrent duplicate
       * submissions. If another request won the race, return its payment.
       */
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        try {
          const existing = await db.query(
            `
              SELECT
                id,
                reference,
                status,
                payee_name,
                payee_reference,
                amount,
                currency,
                description,
                scheduled_for,
                created_at,
                completed_at
              FROM payments
              WHERE customer_id = $1
                AND idempotency_key = $2
              LIMIT 1
            `,
            [customer.id, idempotencyKey],
          )

          if (existing.rowCount === 1) {
            const payment = existing.rows[0]
            if (!matchesPaymentRequest(payment, {
              accountId, payeeName, payeeReference, amount,
              currency, scheduledFor, description,
            })) {
              return res.status(409).json({
                ok: false,
                error: 'Idempotency key was already used for a different request.',
              })
            }

            return res.status(200).json({
              ok: true,
              idempotent: true,
              payment: paymentResponse(payment),
            })
          }
        } catch {
          // Fall through to the generic error response.
        }
      }

      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Customer payment creation failed:', error)

    return res.status(500).json({
      ok: false,
      error: 'Unable to create the payment instruction.',
    })
  }
}
