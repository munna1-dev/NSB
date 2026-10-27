import { AlertCircle, ReceiptText, RefreshCw, Search, CheckCircle2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  getManagementTransactions,
  updateManagementDepositStatus,
  type ManagementTransaction,
} from '../../lib/managementApi'
import './ManagementDataPage.css'

function money(value: string, currency: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(value))
}

export function ManagementTransactionsPage() {
  const [items, setItems] = useState<ManagementTransaction[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reviewBusy, setReviewBusy] = useState<string | null>(null)


  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setItems(await getManagementTransactions(search))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load transactions.')
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [search, load])

  async function reviewDeposit(item: ManagementTransaction, action: 'approve' | 'reject') {
    if (reviewBusy) return
    const verb = action === 'approve' ? 'approve' : 'reject'
    if (!window.confirm(`Are you sure you want to ${verb} deposit ${item.reference}?`)) return
    setReviewBusy(item.id)
    setError('')
    try {
      await updateManagementDepositStatus(item.id, action)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to review deposit.')
    } finally {
      setReviewBusy(null)
    }
  }

  return (
    <div className="management-data">
      <header className="management-page-header">
        <div><span className="management-page-header__eyebrow">LEDGER OVERSIGHT</span><h1>Transactions</h1><p>Review pending deposits and monitor transaction activity across customer accounts.</p></div>
        <button className="management-button management-button--secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Refresh</button>
      </header>

      {error && <div className="management-data__error"><AlertCircle size={17} /> {error}</div>}

      <div className="management-data__toolbar">
        <label className="management-data__search"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Reference, account, customer or description" /></label>
      </div>

      <section className="management-data__card">
        {loading ? (
          <div className="management-data__empty"><RefreshCw className="management-spin" /><span>Loading transactions…</span></div>
        ) : items.length === 0 ? (
          <div className="management-data__empty"><ReceiptText size={30} /><strong>No transactions found</strong></div>
        ) : (
          <div className="management-data__table-wrap">
            <table>
              <thead><tr><th>Reference</th><th>Customer</th><th>Account</th><th>Type</th><th>Status</th><th>Amount</th><th>Date</th><th>Review</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td><div className="management-data__primary">{item.reference}</div><div className="management-data__secondary">{item.description || 'Ledger transaction'}</div></td>
                    <td>{item.first_name} {item.last_name}<div className="management-data__secondary">{item.customer_number}</div></td>
                    <td>{item.account_number}</td>
                    <td>{item.transaction_type}</td>
                    <td><span className={`management-data__badge management-data__badge--${item.status}`}>{item.status}</span></td>
                    <td>{money(item.amount, item.currency)}</td>
                    <td>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</td>
                    <td>
                      {item.transaction_type === 'deposit' && item.status === 'pending' && (
                        <>
                          <button className="management-button management-button--primary"
                            disabled={reviewBusy !== null}
                            onClick={() => void reviewDeposit(item, 'approve')}>
                            <CheckCircle2 size={15} /> {reviewBusy === item.id ? 'Saving…' : 'Approve'}
                          </button>
                          <button className="management-button management-button--danger"
                            disabled={reviewBusy !== null}
                            onClick={() => void reviewDeposit(item, 'reject')}>
                            <XCircle size={15} /> Reject
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
