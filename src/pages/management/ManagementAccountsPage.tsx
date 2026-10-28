import type React from 'react'
import { AlertCircle, Building2, RefreshCw, Search, X, PlusCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  getManagementAccounts,
  updateManagementAccountStatus,
  postManagementDeposit,
  updateManagementWithdrawalControls,
  type ManagementAccount,
} from '../../lib/managementApi'
import './ManagementDataPage.css'

const filters = ['', 'active', 'pending', 'frozen', 'closed']

function money(value: string, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  }).format(Number(value))
}

function date(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function badge(value: string) {
  return `management-data__badge management-data__badge--${value}`
}

export function ManagementAccountsPage() {
  const [items, setItems] = useState<ManagementAccount[]>([])
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ManagementAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [depositAmount, setDepositAmount] = useState('')
  const [depositDescription, setDepositDescription] = useState('')
  const [depositBusy, setDepositBusy] = useState(false)
  const [depositMessage, setDepositMessage] = useState('')
  const [withdrawalsBlocked, setWithdrawalsBlocked] = useState(false)
  const [withdrawalLimit, setWithdrawalLimit] = useState('')
  const [withdrawalBusy, setWithdrawalBusy] = useState(false)
  const [withdrawalMessage, setWithdrawalMessage] = useState('')


  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setItems(await getManagementAccounts(filter || undefined, search))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load accounts.')
    } finally {
      setLoading(false)
    }
  }, [filter, search])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [filter, search, load])

  async function submitDeposit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || depositBusy) return
    if (!window.confirm(`Post a deposit of ${depositAmount} ${selected.currency} to account ${selected.account_number}?`)) return

    setDepositBusy(true)
    setDepositMessage('')
    try {
      await postManagementDeposit(selected.id, depositAmount, depositDescription)
      setDepositAmount('')
      setDepositDescription('')
      setDepositMessage('Deposit posted successfully.')
      const refreshed = await getManagementAccounts(filter || undefined, search)
      setItems(refreshed)
      const refreshedSelected = refreshed.find((account) => account.id === selected.id)
      if (refreshedSelected) setSelected(refreshedSelected)
    } catch (err) {
      setDepositMessage(err instanceof Error ? err.message : 'Unable to post deposit.')
    } finally {
      setDepositBusy(false)
    }
  }

  useEffect(() => {
    setWithdrawalsBlocked(selected?.withdrawals_blocked ?? false)
    setWithdrawalLimit(
      selected?.withdrawal_limit == null ? '' : String(selected.withdrawal_limit),
    )
    setWithdrawalMessage('')
  }, [selected?.id, selected?.withdrawals_blocked, selected?.withdrawal_limit])

  async function saveWithdrawalControls(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || withdrawalBusy) return

    const normalizedLimit = withdrawalLimit.trim() === '' ? null : withdrawalLimit.trim()
    if (normalizedLimit !== null &&
        (!/^\\d+(?:\\.\\d{1,2})?$/.test(normalizedLimit) ||
         !Number.isFinite(Number(normalizedLimit)) ||
         Number(normalizedLimit) < 0 ||
         Number(normalizedLimit) > 1000000000)) {
      setWithdrawalMessage('Enter a maximum of 0 to 1,000,000,000, with up to two decimals; leave blank for no limit.')
      return
    }

    if (!window.confirm('Save withdrawal controls for this account?')) return
    setWithdrawalBusy(true)
    setWithdrawalMessage('')
    try {
      await updateManagementWithdrawalControls(
        selected.id, withdrawalsBlocked, normalizedLimit,
      )
      const refreshed = await getManagementAccounts(filter || undefined, search)
      setItems(refreshed)
      const updated = refreshed.find((account) => account.id === selected.id)
      if (updated) setSelected(updated)
      setWithdrawalMessage('Withdrawal controls saved.')
    } catch (err) {
      setWithdrawalMessage(err instanceof Error ? err.message : 'Unable to save withdrawal controls.')
    } finally {
      setWithdrawalBusy(false)
    }
  }

  async function changeStatus(status: string) {
    if (!selected) return
    if (!window.confirm(`Change this account to ${status}?`)) return
    try {
      const updated = await updateManagementAccountStatus(selected.id, status)
      setSelected(updated)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update account.')
    }
  }

  return (
    <div className="management-data">
      <header className="management-page-header">
        <div>
          <span className="management-page-header__eyebrow">ACCOUNT CONTROL</span>
          <h1>Accounts</h1>
          <p>Review account status, ownership and balances.</p>
        </div>
        <button className="management-button management-button--secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      {error && <div className="management-data__error"><AlertCircle size={17} /> {error}</div>}

      <div className="management-data__toolbar">
        <div className="management-data__filters">
          {filters.map((item) => (
            <button key={item} className={filter === item ? 'management-filter management-filter--active' : 'management-filter'} onClick={() => setFilter(item)}>
              {item || 'All'}
            </button>
          ))}
        </div>
        <label className="management-data__search">
          <Search size={16} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Account, customer or email" />
        </label>
      </div>

      <section className="management-data__card">
        {loading ? (
          <div className="management-data__empty"><RefreshCw className="management-spin" /><span>Loading accounts…</span></div>
        ) : items.length === 0 ? (
          <div className="management-data__empty"><Building2 size={30} /><strong>No accounts found</strong></div>
        ) : (
          <div className="management-data__table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Customer</th><th>Type</th><th>Status</th><th>Available</th><th>Current</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} onClick={() => setSelected(item)}>
                    <td><div className="management-data__primary">{item.account_number}</div><div className="management-data__secondary">{item.currency}</div></td>
                    <td><div className="management-data__primary">{item.first_name} {item.last_name}</div><div className="management-data__secondary">{item.customer_number}</div></td>
                    <td>{item.account_type}</td>
                    <td><span className={badge(item.status)}>{item.status}</span></td>
                    <td>{money(item.available_balance, item.currency)}</td>
                    <td>{money(item.current_balance, item.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <div className="management-data__drawer" onClick={() => setSelected(null)}>
          <aside className="management-data__drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="management-data__drawer-head">
              <div><span className="management-page-header__eyebrow">ACCOUNT</span><h2>{selected.account_number}</h2></div>
              <button className="management-data__close" onClick={() => setSelected(null)}><X /></button>
            </div>
            <div className="management-data__detail">
              <div className="management-data__detail-item"><label>Customer</label>{selected.first_name} {selected.last_name} · {selected.customer_number}</div>
              <div className="management-data__detail-item"><label>Email</label>{selected.email}</div>
              <div className="management-data__detail-item"><label>Account type</label>{selected.account_type}</div>
              <div className="management-data__detail-item"><label>Status</label><span className={badge(selected.status)}>{selected.status}</span></div>
              <div className="management-data__detail-item"><label>Available balance</label>{money(selected.available_balance, selected.currency)}</div>
              <div className="management-data__detail-item"><label>Current balance</label>{money(selected.current_balance, selected.currency)}</div>
              <div className="management-data__detail-item"><label>Opened</label>{date(selected.created_at)}</div>
            </div>
            {selected.status === 'active' && (
              <form onSubmit={submitDeposit} className="management-data__detail" style={{ marginTop: 20 }}>
                <h3><PlusCircle size={17} /> Add deposit</h3>
                <label className="management-data__detail-item">
                  <span>Amount ({selected.currency})</span>
                  <input type="number" min="0.01" max="1000000000" step="0.01"
                    value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} required />
                </label>
                <label className="management-data__detail-item">
                  <span>Description</span>
                  <input value={depositDescription} maxLength={300}
                    onChange={(e) => setDepositDescription(e.target.value)}
                    placeholder="Deposit reason or reference" required />
                </label>
                {depositMessage && <div role="status">{depositMessage}</div>}
                <button type="submit" className="management-button management-button--primary" disabled={depositBusy}>
                  {depositBusy ? 'Posting…' : 'Post deposit'}
                </button>
              </form>
            )}
            <form onSubmit={saveWithdrawalControls} className="management-data__detail" style={{ marginTop: 20 }}>
              <h3>Withdrawal controls</h3>
              <label className="management-data__detail-item">
                <span>
                  <input
                    type="checkbox"
                    checked={withdrawalsBlocked}
                    onChange={(e) => setWithdrawalsBlocked(e.target.checked)}
                  />{' '}
                  Block customer withdrawals
                </span>
              </label>
              <label className="management-data__detail-item">
                <span>Maximum per withdrawal ({selected.currency})</span>
                <input
                  type="number"
                  min="0"
                  max="1000000000"
                  step="0.01"
                  value={withdrawalLimit}
                  onChange={(e) => setWithdrawalLimit(e.target.value)}
                  placeholder="Leave blank for no limit"
                />
              </label>
              <p className="management-data__secondary">
                Blank means no per-withdrawal maximum. A limit of 0 permits no positive withdrawal.
              </p>
              {withdrawalMessage && <div role="status">{withdrawalMessage}</div>}
              <button
                type="submit"
                className="management-button management-button--primary"
                disabled={withdrawalBusy}
              >
                {withdrawalBusy ? 'Saving…' : 'Save withdrawal controls'}
              </button>
            </form>
            <div className="management-data__actions">
              {selected.status !== 'active' && selected.status !== 'closed' && <button className="management-button management-button--primary" onClick={() => void changeStatus('active')}>Activate</button>}
              {selected.status === 'active' && <button className="management-button management-button--secondary" onClick={() => void changeStatus('frozen')}>Freeze</button>}
              {selected.status !== 'closed' && <button className="management-button management-button--danger" onClick={() => void changeStatus('closed')}>Close</button>}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
