import { getDb } from '../db/client.js'

export type TransactionNotification = {
  customerId: string
  type: string
  reference: string
  amount: number | string
  currency: string
  status: string
  accountNumber?: string | null
  description?: string | null
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;',
  })[char]!)
}

export async function sendTransactionNotification(
  item: TransactionNotification,
): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      console.warn('Transaction email skipped: RESEND_API_KEY is not configured.')
      return
    }

    const db = getDb()
    const result = await db.query(
      `SELECT c.email, c.first_name,
              COALESCE(p.email_alerts, TRUE) AS email_alerts,
              COALESCE(p.transaction_alerts, TRUE) AS transaction_alerts
       FROM customers c
       LEFT JOIN customer_preferences p ON p.customer_id = c.id
       WHERE c.id::text = $1
       LIMIT 1`,
      [item.customerId],
    )

    const recipient = result.rows[0]
    if (!recipient?.email ||
        !recipient.email_alerts ||
        !recipient.transaction_alerts) return

    const type = item.type.replace(/[_-]+/g, ' ')
    const status = item.status.replace(/[_-]+/g, ' ')
    const amount = `${item.currency} ${Number(item.amount).toLocaleString(
      'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    )}`
    const subject = `NorthStarBank transaction update: ${type}`
    const safeName = escapeHtml(recipient.first_name || 'Customer')
    const safeType = escapeHtml(type)
    const safeStatus = escapeHtml(status)
    const safeReference = escapeHtml(item.reference)
    const safeAmount = escapeHtml(amount)
    const safeDescription = escapeHtml(item.description || 'Transaction update')
    const maskedAccount = item.accountNumber
      ? `••••${item.accountNumber.replace(/\s/g, '').slice(-4)}`
      : 'Not provided'
    const safeAccount = escapeHtml(maskedAccount)

    const html = `
      <div style="font-family:Arial,sans-serif;color:#243b53;max-width:600px;margin:auto">
        <div style="background:#102a43;color:#fff;padding:24px">
          <h1 style="margin:0;font-size:22px">NorthStarBank</h1>
          <p style="margin:8px 0 0">Transaction notification</p>
        </div>
        <div style="padding:24px;border:1px solid #d9e2ec">
          <p>Hello ${safeName},</p>
          <p>There is an update to your ${safeType} transaction.</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:10px;border-bottom:1px solid #eee">Amount</td><td style="padding:10px;border-bottom:1px solid #eee"><strong>${safeAmount}</strong></td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee">Status</td><td style="padding:10px;border-bottom:1px solid #eee">${safeStatus}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee">Reference</td><td style="padding:10px;border-bottom:1px solid #eee">${safeReference}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #eee">Account</td><td style="padding:10px;border-bottom:1px solid #eee">${safeAccount}</td></tr>
            <tr><td style="padding:10px">Details</td><td style="padding:10px">${safeDescription}</td></tr>
          </table>
          <p>If you do not recognise this activity, contact
          <a href="mailto:support@northstarbank.site">support@northstarbank.site</a>.</p>
          <p style="font-size:12px;color:#627d98">This is an automated notification. Please do not reply directly to this email.</p>
        </div>
      </div>`

    const text = [
      'NorthStarBank transaction notification',
      `Hello ${recipient.first_name || 'Customer'},`,
      `Type: ${type}`,
      `Amount: ${amount}`,
      `Status: ${status}`,
      `Reference: ${item.reference}`,
      `Account: ${maskedAccount}`,
      `Details: ${item.description || 'Transaction update'}`,
      'Support: support@northstarbank.site',
    ].join('\n')

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'NorthStarBank <no-reply@northstarbank.site>',
        reply_to: 'support@northstarbank.site',
        to: [recipient.email],
        subject,
        html,
        text,
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) {
      console.error(`Transaction email provider returned HTTP ${response.status}.`)
    }
  } catch (error) {
    console.error(
      'Transaction notification failed:',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}
