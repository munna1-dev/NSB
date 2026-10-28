import { useEffect, useMemo, useState } from 'react'
import './ManagementCustomersPage.css'
import {
  getManagementCustomers,
  updateManagementCustomerStatus,
  type ManagementCustomer,
} from '../../lib/managementApi'

const STATUS_FILTERS = [
  { value: '', label: 'All customers' },
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'closed', label: 'Closed' },
]

const STATUS_ACTIONS = [
  { value: 'active', label: 'Activate' },
  { value: 'suspended', label: 'Suspend' },
  { value: 'closed', label: 'Close customer' },
]

function formatDate(value: string | null) {
  if (!value) return 'Never'

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatBalance(value: string) {
  const amount = Number(value)

  if (!Number.isFinite(amount)) {
    return '—'
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}

function statusClass(status: string) {
  return `management-status management-status--${status}`
}

export function ManagementCustomersPage() {
  const [customers, setCustomers] = useState<ManagementCustomer[]>([])
  const [filter, setFilter] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ManagementCustomer | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim())
    }, 300)

    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    let mounted = true

    getManagementCustomers(filter || undefined, search || undefined)
      .then((result) => {
        if (!mounted) return
        setCustomers(result)

        setSelected((current) => {
          if (!current) return current

          const refreshed = result.find(
            (customer) => customer.id === current.id,
          )

          return refreshed ?? current
        })
      })
      .catch((loadError) => {
        if (!mounted) return

        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Unable to load customers.',
        )
      })
      .finally(() => {
        if (mounted) {
          setLoading(false)
        }
      })

    return () => {
      mounted = false
    }
  }, [filter, search])

  const customerCountLabel = useMemo(() => {
    if (loading) return 'Loading customers…'

    return `${customers.length} customer${customers.length === 1 ? '' : 's'}`
  }, [customers.length, loading])

  async function changeStatus(
    customer: ManagementCustomer,
    nextStatus: string,
  ) {
    const action =
      nextStatus === 'closed'
        ? 'close this customer and close their open accounts'
        : nextStatus === 'suspended'
          ? 'suspend this customer'
          : 'activate this customer'

    const confirmed = window.confirm(
      `Are you sure you want to ${action}?\n\n${customer.first_name} ${customer.last_name} (${customer.customer_number})`,
    )

    if (!confirmed) return

    setSaving(true)
    setActionError('')

    try {
      const updated = await updateManagementCustomerStatus(
        customer.id,
        nextStatus,
      )

      setCustomers((current) =>
        current.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      )

      setSelected((current) =>
        current?.id === updated.id ? { ...current, ...updated } : current,
      )
    } catch (updateError) {
      setActionError(
        updateError instanceof Error
          ? updateError.message
          : 'Unable to update customer status.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="management-page">
      <div className="management-page__header">
        <div>
          <p className="management-page__eyebrow">Customer operations</p>
          <h1>Customers</h1>
          <p className="management-page__description">
            Review customer profiles, account relationships and operational
            status.
          </p>
        </div>

        <div className="management-page__header-meta">
          <span>{customerCountLabel}</span>
        </div>
      </div>

      <div className="management-card management-customers__toolbar">
        <div className="management-customers__search">
          <label htmlFor="customer-search">Search customers</label>
          <input
            id="customer-search"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Name, email, phone or customer number"
          />
        </div>

        <div className="management-customers__filter">
          <label htmlFor="customer-status-filter">Status</label>
          <select
            id="customer-status-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            {STATUS_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="management-alert management-alert--error">
          {error}
        </div>
      )}

      {actionError && (
        <div className="management-alert management-alert--error">
          {actionError}
        </div>
      )}

      <div className="management-card management-customers__table-card">
        <div className="management-table-wrap">
          <table className="management-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Accounts</th>
                <th>Total balance</th>
                <th>Last login</th>
                <th />
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="management-table__empty">
                    Loading customers…
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="management-table__empty">
                    No customers match the current filters.
                  </td>
                </tr>
              ) : (
                customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <button
                        type="button"
                        className="management-customers__customer-button"
                        onClick={() => {
                          setSelected(customer)
                          setActionError('')
                        }}
                      >
                        <strong>
                          {customer.first_name} {customer.last_name}
                        </strong>
                        <span>{customer.customer_number}</span>
                      </button>
                    </td>

                    <td>
                      <div className="management-table__primary">
                        {customer.email}
                      </div>
                      <div className="management-table__secondary">
                        {customer.phone || 'No phone recorded'}
                      </div>
                    </td>

                    <td>
                      <span className={statusClass(customer.status)}>
                        {customer.status}
                      </span>
                    </td>

                    <td>{customer.account_count}</td>

                    <td>{formatBalance(customer.total_balance)}</td>

                    <td>{formatDate(customer.last_login_at)}</td>

                    <td>
                      <button
                        type="button"
                        className="management-button management-button--secondary"
                        onClick={() => {
                          setSelected(customer)
                          setActionError('')
                        }}
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="management-drawer-backdrop">
          <aside
            className="management-drawer"
            aria-label="Customer details"
          >
            <div className="management-drawer__header">
              <div>
                <p className="management-page__eyebrow">
                  Customer profile
                </p>
                <h2>
                  {selected.first_name} {selected.last_name}
                </h2>
                <p>{selected.customer_number}</p>
              </div>

              <button
                type="button"
                className="management-drawer__close"
                onClick={() => setSelected(null)}
                aria-label="Close customer details"
              >
                ×
              </button>
            </div>

            <div className="management-drawer__body">
              <div className="management-detail-grid">
                <div>
                  <span>Email</span>
                  <strong>{selected.email}</strong>
                </div>

                <div>
                  <span>Phone</span>
                  <strong>{selected.phone || 'Not provided'}</strong>
                </div>

                <div>
                  <span>Status</span>
                  <strong className={statusClass(selected.status)}>
                    {selected.status}
                  </strong>
                </div>

                <div>
                  <span>Role</span>
                  <strong>{selected.role}</strong>
                </div>

                <div>
                  <span>Accounts</span>
                  <strong>{selected.account_count}</strong>
                </div>

                <div>
                  <span>Total balance</span>
                  <strong>{formatBalance(selected.total_balance)}</strong>
                </div>

                <div>
                  <span>Two-factor authentication</span>
                  <strong>
                    {selected.two_factor_enabled ? 'Enabled' : 'Not enabled'}
                  </strong>
                </div>

                <div>
                  <span>Last login</span>
                  <strong>{formatDate(selected.last_login_at)}</strong>
                </div>

                <div>
                  <span>Customer since</span>
                  <strong>{formatDate(selected.created_at)}</strong>
                </div>
              </div>

              <div className="management-drawer__section">
                <h3>Customer controls</h3>

                <p>
                  Status changes are audited. Closing a customer also closes
                  their currently open accounts.
                </p>

                <div className="management-drawer__actions">
                  {STATUS_ACTIONS.map((action) => {
                    const disabled =
                      saving ||
                      selected.role === 'management' ||
                      selected.role === 'developer' ||
                      selected.status === 'closed' ||
                      selected.status === action.value

                    return (
                      <button
                        key={action.value}
                        type="button"
                        className={
                          action.value === 'closed'
                            ? 'management-button management-button--danger'
                            : 'management-button management-button--secondary'
                        }
                        disabled={disabled}
                        onClick={() =>
                          void changeStatus(selected, action.value)
                        }
                      >
                        {saving && selected.status !== action.value
                          ? 'Saving…'
                          : action.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="management-drawer__section">
                <h3>Security boundary</h3>
                <p>
                  Passwords, session tokens and other authentication secrets
                  are not displayed in management customer records.
                </p>
              </div>
            </div>
          </aside>
        </div>
      )}
    </section>
  )
}
