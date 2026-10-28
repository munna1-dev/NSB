import type { VercelRequest, VercelResponse } from '@vercel/node'

import accounts from '../../src/server/api-handlers/customer/accounts.js'
import beneficiaries from '../../src/server/api-handlers/customer/beneficiaries/index.js'
import beneficiaryById from '../../src/server/api-handlers/customer/beneficiaries/[id].js'
import cards from '../../src/server/api-handlers/customer/cards/index.js'
import cardById from '../../src/server/api-handlers/customer/cards/[id].js'
import cardRequests from '../../src/server/api-handlers/customer/cards/requests.js'
import notifications from '../../src/server/api-handlers/customer/notifications/index.js'
import notificationById from '../../src/server/api-handlers/customer/notifications/[id].js'
import notificationsReadAll from '../../src/server/api-handlers/customer/notifications/read-all.js'
import password from '../../src/server/api-handlers/customer/password.js'
import payments from '../../src/server/api-handlers/customer/payments.js'
import profileImage from '../../src/server/api-handlers/customer/profile-image.js'
import profile from '../../src/server/api-handlers/customer/profile.js'
import security from '../../src/server/api-handlers/customer/security.js'
import settings from '../../src/server/api-handlers/customer/settings.js'
import support from '../../src/server/api-handlers/customer/support.js'
import transactions from '../../src/server/api-handlers/customer/transactions.js'
import transfers from '../../src/server/api-handlers/customer/transfers.js'
import withdrawals from '../../src/server/api-handlers/customer/withdrawals.js'

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const queryPath = typeof req.query.path === 'string' ? req.query.path : ''

  const parts = (queryPath || pathname)
    .replace(/^\/api\/customer\/?/, '')
    .split('/')
    .filter(Boolean)

  const [resource, action, id] = parts

  if (resource === 'accounts' && parts.length === 1) {
    return accounts(req, res)
  }

  if (resource === 'beneficiaries') {
    if (parts.length === 1) return beneficiaries(req, res)

    if (parts.length === 2 && id) {
      req.query.id = id
      return beneficiaryById(req, res)
    }
  }

  if (resource === 'cards') {
    if (parts.length === 1) return cards(req, res)

    if (parts.length === 2 && id) {
      req.query.id = id
      return cardById(req, res)
    }
  }

  if (resource === 'cards' && parts.length === 2 && action === 'requests') {
    return cardRequests(req, res)
  }

  if (resource === 'notifications') {
    if (parts.length === 1) return notifications(req, res)

    if (parts.length === 2 && action === 'read-all') {
      return notificationsReadAll(req, res)
    }

    if (parts.length === 2 && id) {
      req.query.id = id
      return notificationById(req, res)
    }
  }

  if (resource === 'password' && parts.length === 1) {
    return password(req, res)
  }

  if (resource === 'payments' && parts.length === 1) {
    return payments(req, res)
  }

  if (resource === 'profile-image' && parts.length === 1) {
    return profileImage(req, res)
  }

  if (resource === 'profile' && parts.length === 1) {
    return profile(req, res)
  }

  if (resource === 'security' && parts.length === 1) {
    return security(req, res)
  }

  if (resource === 'settings' && parts.length === 1) {
    return settings(req, res)
  }

  if (resource === 'support' && parts.length === 1) {
    return support(req, res)
  }

  if (resource === 'transactions' && parts.length === 1) {
    return transactions(req, res)
  }

  if (resource === 'transfers' && parts.length === 1) {
    return transfers(req, res)
  }

  if (resource === 'withdrawals' && parts.length === 1) {
    return withdrawals(req, res)
  }


  return res.status(404).json({
    ok: false,
    error: 'Customer API route not found.',
  })
}
