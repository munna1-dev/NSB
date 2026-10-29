import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Resend } from "resend";
import { Webhook } from "svix";

export const config = { api: { bodyParser: false } };

async function rawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.RESEND_SUPPORT_WEBHOOK_SECRET;
  const apiKey = process.env.RESEND_API_KEY;

  if (!secret || !apiKey) {
    return res.status(500).json({ error: "Email service not configured" });
  }

  let event: any;

  try {
    event = new Webhook(secret).verify(await rawBody(req), {
      "svix-id": String(req.headers["svix-id"] || ""),
      "svix-timestamp": String(req.headers["svix-timestamp"] || ""),
      "svix-signature": String(req.headers["svix-signature"] || ""),
    });
  } catch {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  if (event.type !== "inbox.email.received") {
    return res.status(200).json({ received: true, ignored: true });
  }

  const data = event.data || {};

  if (
    data.inbox_id !== "b37c733b-b9ae-4e39-aa84-03eac505a6ba" ||
    !data.thread_id ||
    !data.email_id
  ) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const resend = new Resend(apiKey);

    const { data: original, error } =
      await resend.inboxes.threads.emails.get({
        inboxId: "support@northstarbank.site",
        threadId: data.thread_id,
        emailId: data.email_id,
      });

    if (error || !original) {
      return res.status(503).json({ error: "Could not retrieve inbox email" });
    }

    const message = original as {
      from?: string;
      reply_to?: string[];
      subject?: string | null;
      text?: string | null;
      html?: string | null;
    };

    const forwarded = await resend.emails.send(
      {
        from: "NorthStarBank Support <support@northstarbank.site>",
        to: ["kwanfrank6@gmail.com"],
        ...(message.from ? { replyTo: message.from } : {}),
        subject: `Support email: ${message.subject || "(no subject)"}`,
        text: message.text || "See the HTML version of this message.",
        ...(message.html ? { html: message.html } : {}),
      },
      { idempotencyKey: `support-forward-${data.email_id}` }
    );

    if (forwarded.error) {
      return res.status(503).json({ error: "Forwarding failed" });
    }

    return res.status(200).json({ received: true, forwarded: true });
  } catch {
    return res.status(503).json({ error: "Temporary forwarding failure" });
  }
}
