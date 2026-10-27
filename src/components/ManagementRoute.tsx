import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { getCurrentStaff } from '../lib/session'
import type { StaffProfile } from '../lib/session'
import { ManagementShell } from './ManagementShell'

interface ManagementRouteProps {
  children: ReactNode
  permission?: string
  permissions?: string[]
  superManagerOnly?: boolean
}

export function ManagementRoute({
  children,
  permission,
  permissions,
  superManagerOnly = false,
}: ManagementRouteProps) {
  const location = useLocation()
  const [staff, setStaff] = useState<StaffProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    void getCurrentStaff().then((result) => {
      if (!mounted) {
        return
      }

      setStaff(result)
      setLoading(false)
    })

    return () => {
      mounted = false
    }
  }, [])

  if (loading) {
    return (
      <main className="management-route-loading">
        <p>Verifying your management session…</p>
      </main>
    )
  }

  if (!staff) {
    return (
      <Navigate
        to="/staff"
        replace
        state={{ from: location.pathname }}
      />
    )
  }

  const staffRole = staff.role as string

  if (superManagerOnly && staffRole !== 'super_manager') {
    return <Navigate to="/management" replace />
  }

  if (staffRole !== 'super_manager') {
    const grantedPermissions = staff.permissions ?? []

    if (
      permission &&
      !grantedPermissions.includes(permission)
    ) {
      return <Navigate to="/management" replace />
    }

    if (
      permissions?.length &&
      !permissions.some((item) =>
        grantedPermissions.includes(item),
      )
    ) {
      return <Navigate to="/management" replace />
    }
  }

  return (
    <ManagementShell staff={staff}>
      {children}
    </ManagementShell>
  )
}
