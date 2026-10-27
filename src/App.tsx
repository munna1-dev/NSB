import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { PublicHome } from "./pages/PublicHome"
import { PersonalPage } from "./pages/PersonalPage"
import { BusinessPage } from "./pages/BusinessPage"
import { AboutPage } from "./pages/AboutPage"
import { SupportPage } from "./pages/SupportPage"
import { SignInPage } from "./pages/SignInPage"
import { StaffSignInPage } from "./pages/StaffSignInPage"
import { OpenAccountPage } from "./pages/OpenAccountPage"
import { CustomerDashboardPage } from "./pages/CustomerDashboardPage"
import { CustomerAccountsPage } from "./pages/CustomerAccountsPage"
import { CustomerTransactionsPage } from "./pages/CustomerTransactionsPage"
import { CustomerTransferPage } from "./pages/CustomerTransferPage"
import { CustomerPaymentsPage } from "./pages/CustomerPaymentsPage"
import { CustomerProfilePage } from "./pages/CustomerProfilePage"
import { CustomerSupportPage } from "./pages/CustomerSupportPage"
import { CustomerCardsPage } from "./pages/CustomerCardsPage"
import { CustomerNotificationsPage } from "./pages/CustomerNotificationsPage"
import { CustomerStatementsPage } from "./pages/CustomerStatementsPage"
import { CustomerBeneficiariesPage } from "./pages/CustomerBeneficiariesPage"
import { CustomerSettingsPage } from "./pages/CustomerSettingsPage"
import { CustomerSecurityPage } from "./pages/CustomerSecurityPage"
import { ProtectedRoute } from "./components/ProtectedRoute"
import { ManagementRoute } from "./components/ManagementRoute"
import { ManagementDashboardPage } from "./pages/management/ManagementDashboardPage"
import { ManagementApplicationsPage } from "./pages/management/ManagementApplicationsPage"
import { ManagementCardRequestsPage } from "./pages/management/ManagementCardRequestsPage"
import { ManagementCustomersPage } from "./pages/management/ManagementCustomersPage"
import { ManagementAccountsPage } from "./pages/management/ManagementAccountsPage"
import { ManagementTransactionsPage } from "./pages/management/ManagementTransactionsPage"
import { ManagementOperationsPage } from "./pages/management/ManagementOperationsPage"
import { ManagementSupportPage } from "./pages/management/ManagementSupportPage"
import { ManagementAuditPage } from "./pages/management/ManagementAuditPage"
import ManagementStaffPage from "./pages/management/ManagementStaffPage"
import { ManagementProfilePage } from "./pages/management/ManagementProfilePage"
import { SessionSecurity } from "./components/SessionSecurity"

function App() {
  return (
    <BrowserRouter>
      <SessionSecurity />
      <Routes>
        <Route path="/" element={<PublicHome />} />
        <Route path="/personal" element={<PersonalPage />} />
        <Route path="/business" element={<BusinessPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/login" element={<SignInPage />} />
        <Route path="/signin" element={<Navigate to="/login" replace />} />
        <Route path="/staff" element={<StaffSignInPage />} />
        <Route path="/admin" element={<StaffSignInPage />} />
        <Route path="/open-account" element={<OpenAccountPage />} />
        <Route path="/customer" element={<ProtectedRoute><CustomerDashboardPage /></ProtectedRoute>} />
        <Route path="/customer/accounts" element={<ProtectedRoute><CustomerAccountsPage /></ProtectedRoute>} />
        <Route path="/customer/transactions" element={<ProtectedRoute><CustomerTransactionsPage /></ProtectedRoute>} />
        <Route path="/customer/transfer" element={<ProtectedRoute><CustomerTransferPage /></ProtectedRoute>} />
        <Route path="/customer/payments" element={<ProtectedRoute><CustomerPaymentsPage /></ProtectedRoute>} />
        <Route path="/customer/profile" element={<ProtectedRoute><CustomerProfilePage /></ProtectedRoute>} />
        <Route path="/customer/support" element={<ProtectedRoute><CustomerSupportPage /></ProtectedRoute>} />
        <Route path="/customer/cards" element={<ProtectedRoute><CustomerCardsPage /></ProtectedRoute>} />
        <Route path="/customer/notifications" element={<ProtectedRoute><CustomerNotificationsPage /></ProtectedRoute>} />
        <Route path="/customer/statements" element={<ProtectedRoute><CustomerStatementsPage /></ProtectedRoute>} />
        <Route path="/customer/beneficiaries" element={<ProtectedRoute><CustomerBeneficiariesPage /></ProtectedRoute>} />
        <Route
          path="/customer/settings"
          element={
            <ProtectedRoute>
              <CustomerSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/customer/security"
          element={
            <ProtectedRoute>
              <CustomerSecurityPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/management"
          element={
            <ManagementRoute permission="dashboard.view">
              <ManagementDashboardPage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/applications"
          element={
            <ManagementRoute permission="applications.view">
              <ManagementApplicationsPage />
            </ManagementRoute>
          }
        />

        <Route
          path="/management/customers"
          element={
            <ManagementRoute permission="customers.view">
              <ManagementCustomersPage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/accounts"
          element={
            <ManagementRoute permission="accounts.view">
              <ManagementAccountsPage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/card-requests"
          element={
            <ManagementRoute permission="cards.view">
              <ManagementCardRequestsPage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/transactions"
          element={
            <ManagementRoute permission="transactions.view">
              <ManagementTransactionsPage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/operations"
          element={
            <ManagementRoute
              permissions={["transfers.view", "payments.view"]}
            >
              <ManagementOperationsPage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/support"
          element={
            <ManagementRoute permission="support.view">
              <ManagementSupportPage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/audit"
          element={
            <ManagementRoute permission="audit.view">
              <ManagementAuditPage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/profile"
          element={
            <ManagementRoute permission="profile.view">
              <ManagementProfilePage />
            </ManagementRoute>
          }
        />
        <Route
          path="/management/staff"
          element={
            <ManagementRoute superManagerOnly>
              <ManagementStaffPage />
            </ManagementRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App

import "./pages/customer-portal-fixes.css"
