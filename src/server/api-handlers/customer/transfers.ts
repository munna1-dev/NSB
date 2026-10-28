import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { requireCustomer } from '../../auth/customer.js'
import { getDb } from '../../db/client.js'

const transferSchema = z.object({
  fromAccountId: z.string().uuid('Invalid source account.'),
  toAccountId: z.string().uuid('Invalid destination account.'),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter a valid amount with up to 2 decimal places.')
    .refine((value) => Number(value) > 0, 'Transfer amount must be greater than zero.'),
  description: z
    .string()
    .trim()
    .max(500, 'Description is too long.')
    .optional()
    .default(''),
  idempotencyKey: z
    .string()
    .uuid('Invalid idempotency key.'),
})

function matchesTransferRequest(
  transfer: Record<string, unknown>,
  request: {
    fromAccountId: string;
    toAccountId: string;
    amount: string;
    description: string;
  },
): boolean {
  return String(transfer.from_account_id) === request.fromAccountId
    && String(transfer.to_account_id) === request.toAccountId
    && Number(transfer.amount) === Number(request.amount)
    && (transfer.description ?? '') === request.description;
}

function requestIp(req: VercelRequest): string | null {
  const forwarded = req.headers['x-forwarded-for']

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() || null
  }

  return typeof req.socket?.remoteAddress === 'string'
    ? req.socket.remoteAddress
    : null
}

function makeReference(prefix: string): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).slice(2, 10).toUpperCase()

  return `${prefix}-${timestamp}-${random}`
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

  const customer = await requireCustomer(req)

  if (!customer) {
    return res.status(401).json({
      ok: false,
      authenticated: false,
      error: 'Not authenticated.',
    })
  }

  const parsed = transferSchema.safeParse({
    ...((req.body ?? {}) as Record<string, unknown>),
    idempotencyKey:
      (req.body as Record<string, unknown> | undefined)?.idempotencyKey ??
      req.headers['idempotency-key'],
  })

  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid transfer request.',
    })
  }

  const {
    fromAccountId,
    toAccountId,
    amount,
    description,
    idempotencyKey,
  } = parsed.data

  if (fromAccountId === toAccountId) {
    return res.status(400).json({
      ok: false,
      error: 'Source and destination accounts must be different.',
    })
  }

  const db = getDb()
  const client = await db.connect()

  try {
    await client.query('BEGIN')

    /*
     * Idempotency is checked inside the transaction so a retried request
     * can safely return the original completed operation.
     */
    const existingTransfer = await client.query(
      `
        SELECT
          id,
          reference,
          status,
          amount,
          currency,
          from_account_id,
          to_account_id,
          description,
          created_at,
          completed_at
        FROM transfers
        WHERE customer_id = $1
          AND idempotency_key = $2
        LIMIT 1
      `,
      [customer.id, idempotencyKey],
    )

    if (existingTransfer.rowCount === 1) {
      const existing = existingTransfer.rows[0]
      if (!matchesTransferRequest(existing, {
        fromAccountId, toAccountId, amount, description,
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
        transfer: {
          id: existing.id,
          reference: existing.reference,
          status: existing.status,
          amount: Number(existing.amount),
          currency: existing.currency,
          fromAccountId: existing.from_account_id,
          toAccountId: existing.to_account_id,
          description: existing.description,
          createdAt: existing.created_at,
          completedAt: existing.completed_at,
        },
      })
    }

    /*
     * Lock both accounts in deterministic UUID order. This reduces the
     * possibility of two concurrent transfers deadlocking each other.
     */
    const accountIds = [fromAccountId, toAccountId].sort()

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
        WHERE id IN ($1, $2)
        ORDER BY id
        FOR UPDATE
      `,
      accountIds,
    )

    if (accountResult.rowCount !== 2) {
      await client.query('ROLLBACK')

      return res.status(404).json({
        ok: false,
        error: 'One or both accounts could not be found.',
      })
    }

    const accounts = new Map(
      accountResult.rows.map((account) => [account.id, account]),
    )

    const source = accounts.get(fromAccountId)
    const destination = accounts.get(toAccountId)

    if (!source || !destination) {
      await client.query('ROLLBACK')

      return res.status(404).json({
        ok: false,
        error: 'One or both accounts could not be found.',
      })
    }

    if (
      source.customer_id !== customer.id ||
      destination.customer_id !== customer.id
    ) {
      await client.query('ROLLBACK')

      return res.status(403).json({
        ok: false,
        error: 'You can only transfer between your own accounts.',
      })
    }

    if (source.status !== 'active' || destination.status !== 'active') {
      await client.query('ROLLBACK')

      return res.status(409).json({
        ok: false,
        error: 'Both accounts must be active before a transfer can be made.',
      })
    }

    if (source.currency !== destination.currency) {
      await client.query('ROLLBACK')

      return res.status(409).json({
        ok: false,
        error: 'Transfers between accounts with different currencies are not supported.',
      })
    }

    /*
     * Keep the amount as a decimal string when passing it to PostgreSQL.
     * PostgreSQL NUMERIC performs the authoritative financial calculation.
     */
    const sourceBalance = String(source.available_balance)

    const balanceCheck = await client.query(
      `
        SELECT
          ($1::numeric <= $2::numeric) AS sufficient
      `,
      [amount, sourceBalance],
    )

    if (!balanceCheck.rows[0]?.sufficient) {
      await client.query('ROLLBACK')

      return res.status(409).json({
        ok: false,
        error: 'The transfer amount exceeds the available balance.',
      })
    }

    const transferReference = makeReference('NS-TRF')

    const transferResult = await client.query(
      `
        INSERT INTO transfers (
          customer_id,
          from_account_id,
          to_account_id,
          amount,
          currency,
          description,
          status,
          reference,
          idempotency_key,
          completed_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          NULLIF($6, ''),
          'completed',
          $7,
          $8,
          CURRENT_TIMESTAMP
        )
        RETURNING
          id,
          reference,
          status,
          amount,
          currency,
          from_account_id,
          to_account_id,
          description,
          created_at,
          completed_at
      `,
      [
        customer.id,
        fromAccountId,
        toAccountId,
        amount,
        source.currency,
        description,
        transferReference,
        idempotencyKey,
      ],
    )

    const transfer = transferResult.rows[0]

    const debitReference = makeReference('NS-TXN')
    const creditReference = makeReference('NS-TXN')

    const debitResult = await client.query(
      `
        INSERT INTO transactions (
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
          'transfer',
          'completed',
          $3,
          -$4,
          $5,
          $6
        )
        RETURNING id
      `,
      [
        fromAccountId,
        debitReference,
        description || `Transfer to ${destination.account_number}`,
        amount,
        source.currency,
        JSON.stringify({
          transferId: transfer.id,
          transferReference: transfer.reference,
          direction: 'debit',
          relatedAccountId: toAccountId,
        }),
      ],
    )

    const debitTransactionId = debitResult.rows[0].id

    const creditResult = await client.query(
      `
        INSERT INTO transactions (
          account_id,
          reference,
          transaction_type,
          status,
          description,
          amount,
          currency,
          related_transaction_id,
          metadata
        )
        VALUES (
          $1,
          $2,
          'transfer',
          'completed',
          $3,
          $4,
          $5,
          $6,
          $7
        )
        RETURNING id
      `,
      [
        toAccountId,
        creditReference,
        description || `Transfer from ${source.account_number}`,
        amount,
        destination.currency,
        debitTransactionId,
        JSON.stringify({
          transferId: transfer.id,
          transferReference: transfer.reference,
          direction: 'credit',
          relatedAccountId: fromAccountId,
        }),
      ],
    )

    const creditTransactionId = creditResult.rows[0].id

    await client.query(
      `
        UPDATE transactions
        SET related_transaction_id = $1
        WHERE id = $2
      `,
      [creditTransactionId, debitTransactionId],
    )

    const balanceResult = await client.query(
      `
        UPDATE accounts
        SET
          available_balance = available_balance - $1,
          current_balance = current_balance - $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING
          available_balance,
          current_balance
      `,
      [amount, amount, fromAccountId],
    )

    await client.query(
      `
        UPDATE accounts
        SET
          available_balance = available_balance + $1,
          current_balance = current_balance + $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `,
      [amount, amount, toAccountId],
    )

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
          'customer.transfer.completed',
          'transfer',
          $2,
          $3,
          $4,
          $5,
          $6
        )
      `,
      [
        customer.id,
        transfer.id,
        `Internal transfer ${transfer.reference} completed.`,
        requestIp(req),
        req.headers['user-agent'] ?? null,
        JSON.stringify({
          transferReference: transfer.reference,
          fromAccountId,
          toAccountId,
          debitTransactionId,
          creditTransactionId,
          amount,
          currency: source.currency,
        }),
      ],
    )

    await client.query('COMMIT')

    const newSourceBalance = balanceResult.rows[0]

    return res.status(201).json({
      ok: true,
      idempotent: false,
      transfer: {
        id: transfer.id,
        reference: transfer.reference,
        status: transfer.status,
        amount: Number(transfer.amount),
        currency: transfer.currency,
        fromAccountId: transfer.from_account_id,
        toAccountId: transfer.to_account_id,
        description: transfer.description,
        createdAt: transfer.created_at,
        completedAt: transfer.completed_at,
      },
      sourceAccount: {
        id: fromAccountId,
        availableBalance: Number(newSourceBalance.available_balance),
        currentBalance: Number(newSourceBalance.current_balance),
      },
    })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The original database error is more useful to the caller/log.
    }

    /*
     * A concurrent request may have won the idempotency race. PostgreSQL's
     * unique constraint protects us from executing the operation twice.
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
              amount,
              currency,
              from_account_id,
              to_account_id,
              description,
              created_at,
              completed_at
            FROM transfers
            WHERE customer_id = $1
              AND idempotency_key = $2
            LIMIT 1
          `,
          [customer.id, idempotencyKey],
        )

        if (existing.rowCount === 1) {
          const transfer = existing.rows[0]
          if (!matchesTransferRequest(transfer, {
            fromAccountId, toAccountId, amount, description,
          })) {
            return res.status(409).json({
              ok: false,
              error: 'Idempotency key was already used for a different request.',
            })
          }

          return res.status(200).json({
            ok: true,
            idempotent: true,
            transfer: {
              id: transfer.id,
              reference: transfer.reference,
              status: transfer.status,
              amount: Number(transfer.amount),
              currency: transfer.currency,
              fromAccountId: transfer.from_account_id,
              toAccountId: transfer.to_account_id,
              description: transfer.description,
              createdAt: transfer.created_at,
              completedAt: transfer.completed_at,
            },
          })
        }
      } catch {
        // Fall through to the generic error response.
      }
    }

    console.error('Customer transfer failed:', error)

    return res.status(500).json({
      ok: false,
      error: 'Unable to complete the transfer.',
    })
  } finally {
    client.release()
  }
}
