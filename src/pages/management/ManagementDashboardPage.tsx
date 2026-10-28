import {
  Activity,
  ArrowRight,
  Banknote,
  Building2,
  ClipboardCheck,
  CreditCard,
  FileClock,
  ReceiptText,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getManagementDashboard,
  type ManagementDashboard,
} from '../../lib/managementApi'
import './ManagementDashboardPage.css'

interface Metric {
  label: string
  value: number
  icon: typeof Users
  href: string
}

export function ManagementDashboardPage() {
  const [dashboard, setDashboard] =
    useState<ManagementDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function loadDashboard() {
    setLoading(true)
    setError('')

    try {
      setDashboard(await getManagementDashboard())
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Unable to load management dashboard.',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true

    async function load() {
      setLoading(true)
      setError('')

      try {
        const result = await getManagementDashboard()

        if (mounted) {
          setDashboard(result)
        }
      } catch (loadError) {
        if (mounted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Unable to load management dashboard.',
          )
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      mounted = false
    }
  }, [])

  const metrics: Metric[] = dashboard
    ? [
        {
          label: 'Active customers',
          value: dashboard.active_customers,
          icon: Users,
          href: '/management/customers',
        },
        {
          label: 'Active accounts',
          value: dashboard.active_accounts,
          icon: Building2,
          href: '/management/accounts',
        },
        {
          label: 'Pending applications',
          value: dashboard.pending_applications,
          icon: ClipboardCheck,
          href: '/management/applications',
        },
        {
          label: 'Open support tickets',
          value: dashboard.open_support_tickets,
          icon: Activity,
          href: '/management/support',
        },
        {
          label: 'Pending transfers',
          value: dashboard.pending_transfers,
          icon: ReceiptText,
          href: '/management/operations',
        },
        {
          label: 'Pending payments',
          value: dashboard.pending_payments,
          icon: CreditCard,
          href: '/management/operations',
        },
        {
          label: 'Audit events · 24h',
          value: dashboard.audit_events_24h,
          icon: FileClock,
          href: '/management/audit',
        },
        {
          label: 'Pending customers',
          value: dashboard.pending_customers,
          icon: Users,
          href: '/management/customers',
        },
      ]
    : []

  return (
    <section className="management-dashboard">
      <header className="management-dashboard__header">
        <div>
          <span className="management-dashboard__eyebrow">
            OPERATIONS OVERVIEW
          </span>
          <h1>Management dashboard</h1>
          <p>
            Monitor customer operations, account activity, approvals,
            and control events.
          </p>
        </div>

        <div className="management-dashboard__header-actions">
          <Link
            className="management-dashboard__deposit-action"
            to="/management/accounts"
          >
            <Banknote size={17} />
            Post deposit
          </Link>
          <Link
            className="management-dashboard__primary-action"
            to="/management/applications"
          >
            Review applications
            <ArrowRight size={16} />
          </Link>
        </div>
      </header>

      {loading ? (
        <div className="management-dashboard__state">
          Loading management metrics…
        </div>
      ) : error ? (
        <div className="management-dashboard__error" role="alert">
          <strong>Unable to load dashboard</strong>
          <p>{error}</p>
          <button type="button" onClick={() => void loadDashboard()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="management-dashboard__metrics">
            {metrics.map((metric) => {
              const Icon = metric.icon

              return (
                <Link
                  className="management-dashboard__metric"
                  to={metric.href}
                  key={metric.label}
                >
                  <div className="management-dashboard__metric-icon">
                    <Icon size={19} />
                  </div>
                  <div>
                    <span>{metric.label}</span>
                    <strong>{metric.value.toLocaleString()}</strong>
                  </div>
                  <ArrowRight size={15} />
                </Link>
              )
            })}
          </div>

          <div className="management-dashboard__lower">
            <section className="management-dashboard__panel">
              <div className="management-dashboard__panel-heading">
                <div>
                  <span>WORK QUEUE</span>
                  <h2>Priority operations</h2>
                </div>
              </div>

              <div className="management-dashboard__queue">
                <Link to="/management/applications">
                  <ClipboardCheck size={19} />
                  <div>
                    <strong>Account applications</strong>
                    <span>
                      Review pending and under-review applications.
                    </span>
                  </div>
                  <ArrowRight size={16} />
                </Link>

                <Link to="/management/operations">
                  <ReceiptText size={19} />
                  <div>
                    <strong>Transfers & payments</strong>
                    <span>
                      Review pending customer financial instructions.
                    </span>
                  </div>
                  <ArrowRight size={16} />
                </Link>

                <Link to="/management/support">
                  <Activity size={19} />
                  <div>
                    <strong>Customer support</strong>
                    <span>
                      Monitor unresolved customer service cases.
                    </span>
                  </div>
                  <ArrowRight size={16} />
                </Link>
              </div>
            </section>

            <section className="management-dashboard__panel management-dashboard__panel--secure">
              <ShieldIcon />
              <span>CONTROL & AUDIT</span>
              <h2>Every management action is attributable.</h2>
              <p>
                Administrative changes are recorded with the acting
                user, resource, timestamp, request metadata, and
                action details.
              </p>
              <Link to="/management/audit">
                Open audit log
                <ArrowRight size={16} />
              </Link>
            </section>
          </div>
        </>
      )}
    </section>
  )
}

function ShieldIcon() {
  return (
    <div className="management-dashboard__shield">
      <Activity size={19} />
    </div>
  )
}
