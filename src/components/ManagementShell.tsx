import { useState, type ReactNode } from 'react'
import {
  Activity,
  Building2,
  ClipboardCheck,
  CreditCard,
  FileClock,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  ShieldCheck,
  UserCog,
  Users,
  UserRound,
  X,
} from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import type { StaffProfile } from '../lib/session'
import { signOutStaff } from '../lib/session'
import { BrandMark } from './BrandMark'
import './ManagementShell.css'
import '../pages/management/ManagementApplicationsPage.css'

interface ManagementShellProps {
  staff: StaffProfile
  children: ReactNode
}

const navigation: Array<{
  label: string
  href: string
  icon: typeof LayoutDashboard
  permissions?: string[]
  superManagerOnly?: boolean
}> = [
  {
    label: 'Dashboard',
    href: '/management',
    icon: LayoutDashboard,
    permissions: ['dashboard.view'],
  },
  {
    label: 'Applications',
    href: '/management/applications',
    icon: ClipboardCheck,
    permissions: ['applications.view'],
  },
  {
    label: 'Customers',
    href: '/management/customers',
    icon: Users,
    permissions: ['customers.view'],
  },
  {
    label: 'Accounts',
    href: '/management/accounts',
    icon: Building2,
    permissions: ['accounts.view'],
  },
  {
    label: 'Card Requests',
    href: '/management/card-requests',
    icon: CreditCard,
    permissions: ['cards.view'],
  },
  {
    label: 'Transactions',
    href: '/management/transactions',
    icon: ReceiptText,
    permissions: ['transactions.view'],
  },
  {
    label: 'Transfers & Payments',
    href: '/management/operations',
    icon: CreditCard,
    permissions: ['transfers.view', 'payments.view'],
  },
  {
    label: 'Support',
    href: '/management/support',
    icon: Activity,
    permissions: ['support.view'],
  },
  {
    label: 'Audit Log',
    href: '/management/audit',
    icon: FileClock,
    permissions: ['audit.view'],
  },
  {
    label: 'My Profile',
    href: '/management/profile',
    icon: UserRound,
    permissions: ['profile.view'],
  },
  {
    label: 'Staff Control',
    href: '/management/staff',
    icon: UserCog,
    superManagerOnly: true,
  },
]

export function ManagementShell({
  staff,
  children,
}: ManagementShellProps) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  async function handleLogout() {
    await signOutStaff()
    navigate('/staff', { replace: true })
  }

  return (
    <div className="management-shell">
      <aside
        className={
          open
            ? 'management-shell__sidebar management-shell__sidebar--open'
            : 'management-shell__sidebar'
        }
      >
        <div className="management-shell__brand">
          <BrandMark compact />
          <div>
            <strong>NorthStarBank</strong>
            <span>
              {staff.role === 'super_manager'
                ? 'Super Manager'
                : staff.role === 'developer'
                  ? 'Developer'
                  : staff.role === 'staff'
                    ? 'Staff'
                    : 'Management'}
            </span>
          </div>
          <button
            className="management-shell__close"
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <div className="management-shell__section-label">
          OPERATIONS
        </div>

        <nav className="management-shell__nav">
          {navigation
            .filter((item) => {
              if (
                item.superManagerOnly &&
                staff.role !== 'super_manager'
              ) {
                return false
              }

              if (!item.permissions?.length) {
                return true
              }

              if (staff.role === 'super_manager') {
                return true
              }

              const permissions = staff.permissions ?? []

              return item.permissions.some((permission) =>
                permissions.includes(permission),
              )
            })
            .map((item) => {
              const Icon = item.icon

              return (
              <NavLink
                key={item.href}
                to={item.href}
                end={item.href === '/management'}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  isActive
                    ? 'management-shell__nav-link management-shell__nav-link--active'
                    : 'management-shell__nav-link'
                }
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            )
          })}
        </nav>

        <div className="management-shell__security">
          <ShieldCheck size={17} />
          <div>
            <strong>Authorized access</strong>
            <span>Management controls are audited.</span>
          </div>
        </div>

        <button
          type="button"
          className="management-shell__logout"
          onClick={() => void handleLogout()}
        >
          <LogOut size={17} />
          Sign out
        </button>
      </aside>

      {open && (
        <button
          className="management-shell__backdrop"
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="management-shell__main">
        <header className="management-shell__topbar">
          <button
            type="button"
            className="management-shell__menu"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
          >
            <Menu size={21} />
          </button>

          <div className="management-shell__title">
            <span>MANAGEMENT PORTAL</span>
            <strong>NorthStarBank Operations</strong>
          </div>

          <div className="management-shell__user">
            <div>
              <strong>
                {staff.firstName} {staff.lastName}
              </strong>
              <span>
                {staff.role === 'super_manager'
                  ? 'Super Manager'
                  : staff.role === 'developer'
                    ? 'Developer'
                    : staff.role === 'staff'
                      ? 'Staff'
                      : 'Management'}
              </span>
            </div>
            <div className="management-shell__avatar">
              {staff.firstName.charAt(0)}
              {staff.lastName.charAt(0)}
            </div>
          </div>
        </header>

        <main className="management-shell__content">
          {children}
        </main>
      </div>
    </div>
  )
}
