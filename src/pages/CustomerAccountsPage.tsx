import {
  ArrowRight,
  Plus,
  CreditCard,
  Landmark,
  PiggyBank,
  WalletCards,
} from "lucide-react"
import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { Link } from "react-router-dom"
import { getCustomerAccounts, getCustomerProfile } from "../lib/customerApi"
import { formatCurrency } from "../lib/format"
import type { AccountType, BankAccount } from "../types"
import "./CustomerAccountsPage.css"

function accountIcon(type: AccountType) {
  switch (type) {
    case "checking":
      return <WalletCards size={21} />
    case "savings":
      return <PiggyBank size={21} />
    case "business":
      return <Landmark size={21} />
    case "credit":
      return <CreditCard size={21} />
    default:
      return <CreditCard size={21} />
  }
}

function accountLabel(type: AccountType) {
  return type.charAt(0).toUpperCase() + type.slice(1)
}

export function CustomerAccountsPage() {
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [showApplicationForm, setShowApplicationForm] = useState(false)
  const [applicationType, setApplicationType] = useState<AccountType>("checking")
  const [applicationSubmitting, setApplicationSubmitting] = useState(false)
  const [applicationError, setApplicationError] = useState("")
  const [applicationReference, setApplicationReference] = useState("")

  const availableAccountTypes: AccountType[] = (
    ["checking", "savings", "business", "credit"] as AccountType[]
  ).filter(
    (type) => !accounts.some(
      (account) => account.accountType === type && account.status !== "closed",
    ),
  )

  useEffect(() => {
    let mounted = true

    async function loadAccounts() {
      try {
        const result = await getCustomerAccounts()

        if (!mounted) {
          return
        }

        setAccounts(result)
      } catch (loadError) {
        if (!mounted) {
          return
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load your accounts.",
        )
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    void loadAccounts()

    return () => {
      mounted = false
    }
  }, [])

  async function submitApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setApplicationError("")
    setApplicationReference("")

    const selectedType = availableAccountTypes.includes(applicationType)
      ? applicationType
      : availableAccountTypes[0]

    if (!selectedType) {
      setApplicationError("There are no additional account types available to apply for.")
      return
    }

    setApplicationSubmitting(true)

    try {
      const profile = await getCustomerProfile()
      const response = await fetch("/api/public/account-applications", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountType: selectedType,
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: profile.email,
          phone: profile.phone || "",
        }),
      })

      const result = await response.json()

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Unable to submit your application.")
      }

      setApplicationReference(result.application?.reference || "Received")
      setShowApplicationForm(false)
    } catch (reason) {
      setApplicationError(
        reason instanceof Error
          ? reason.message
          : "Unable to submit your application.",
      )
    } finally {
      setApplicationSubmitting(false)
    }
  }

  if (loading) {
    return (
      <section className="customer-accounts">
        <div className="customer-accounts__loading">
          <p>Loading your accounts…</p>
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section className="customer-accounts">
        <div className="customer-accounts__error" role="alert">
          <strong>Unable to load your accounts</strong>
          <p>{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="customer-accounts">
      <header className="customer-accounts__hero">
        <div>
          <span className="customer-accounts__eyebrow">
            CUSTOMER BANKING
          </span>
          <h1>Your accounts</h1>
          <p>
            Review your NorthStarBank accounts, balances, and current
            account status.
          </p>
          <button
            type="button"
            className="customer-accounts__apply-button"
            disabled={availableAccountTypes.length === 0}
            onClick={() => {
              setApplicationError("")
              setShowApplicationForm((visible) => !visible)
            }}
          >
            <Plus size={17} />
            Open another account
          </button>
        </div>
      </header>

      {showApplicationForm && (
        <form
          className="customer-accounts__application-form"
          onSubmit={submitApplication}
        >
          <h2>Apply for another account</h2>
          <p>
            Your application will be linked to your existing customer profile
            and reviewed by NorthStarBank management.
          </p>
          <label>
            Account type
            <select
              value={
                availableAccountTypes.includes(applicationType)
                  ? applicationType
                  : availableAccountTypes[0] || ""
              }
              onChange={(event) =>
                setApplicationType(event.target.value as AccountType)
              }
              required
            >
              {availableAccountTypes.map((type) => (
                <option value={type} key={type}>
                  {type === "credit"
                    ? "Credit account"
                    : type.charAt(0).toUpperCase() + type.slice(1)}
                </option>
              ))}
            </select>
          </label>
          {applicationError && (
            <p className="customer-accounts__application-error" role="alert">
              {applicationError}
            </p>
          )}
          <div className="customer-accounts__application-actions">
            <button type="submit" disabled={applicationSubmitting || !availableAccountTypes.length}>
              {applicationSubmitting ? "Submitting…" : "Submit application"}
            </button>
            <button
              type="button"
              onClick={() => setShowApplicationForm(false)}
              disabled={applicationSubmitting}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {applicationReference && (
        <div className="customer-accounts__application-success" role="status">
          <strong>Application received</strong>
          <p>
            Reference: {applicationReference}. Your application is awaiting
            management review. Approved accounts will appear here under your
            existing customer profile.
          </p>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="customer-accounts__empty">
          <CreditCard size={28} />
          <h2>No accounts available</h2>
          <p>
            There are no active or pending accounts associated with
            your customer profile.
          </p>
          <Link to="/open-account">
            Explore account options
            <ArrowRight size={17} />
          </Link>
        </div>
      ) : (
        <div className="customer-accounts__list">
          {accounts.map((account) => (
            <article
              className="customer-accounts__card"
              key={account.id}
            >
              <div className="customer-accounts__card-top">
                <div className="customer-accounts__icon">
                  {accountIcon(account.accountType)}
                </div>

                <div>
                  <span className="customer-accounts__type">
                    {accountLabel(account.accountType)}
                  </span>
                  <h2>{account.accountNumber}</h2>
                </div>

                <span
                  className={`customer-accounts__status customer-accounts__status--${account.status}`}
                >
                  {account.status}
                </span>
              </div>

              <div className="customer-accounts__balances">
                <div>
                  <span>Available balance</span>
                  <strong>
                    {formatCurrency(
                      account.availableBalance,
                      account.currency,
                    )}
                  </strong>
                </div>

                <div>
                  <span>Current balance</span>
                  <strong>
                    {formatCurrency(
                      account.currentBalance,
                      account.currency,
                    )}
                  </strong>
                </div>

                <div>
                  <span>Currency</span>
                  <strong>{account.currency}</strong>
                </div>
              </div>

              <div className="customer-accounts__card-footer">
                <Link
                  to={`/customer/transactions?account=${encodeURIComponent(
                    account.id,
                  )}`}
                >
                  View transactions
                  <ArrowRight size={16} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
