import {
  Camera,
  CheckCircle2,
  ImagePlus,
  Mail,
  Phone,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import {
  getCustomerProfile,
  removeCustomerProfileImage,
  uploadCustomerProfileImage,
} from "../lib/customerApi"
import { signOutCustomer } from "../lib/session"
import type { UserProfile } from "../types"
import "./CustomerProfilePage.css"

const MAX_PROFILE_IMAGE_SIZE = 5 * 1024 * 1024
const ALLOWED_PROFILE_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
]

export function CustomerProfilePage() {
  const [customer, setCustomer] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [imageBusy, setImageBusy] = useState(false)
  const [imageMessage, setImageMessage] = useState("")
  const [imageError, setImageError] = useState("")
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imageLoadFailed, setImageLoadFailed] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let mounted = true

    async function loadProfile() {
      try {
        const result = await getCustomerProfile()

        if (!mounted) {
          return
        }

        setCustomer(result)
      } catch (loadError) {
        if (!mounted) {
          return
        }

        setImageError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load your profile.",
        )
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    void loadProfile()

    return () => {
      mounted = false
    }
  }, [])

  async function handleProfileImageChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0]

    event.target.value = ""

    if (!file || !customer) {
      return
    }

    setImageError("")
    setImageMessage("")

    if (!ALLOWED_PROFILE_IMAGE_TYPES.includes(file.type)) {
      setImageError("Choose a JPEG, PNG, or WebP image.")
      return
    }

    if (file.size > MAX_PROFILE_IMAGE_SIZE) {
      setImageError("Profile images must be 5 MB or smaller.")
      return
    }

    setImageLoadFailed(false)
    setPreviewUrl(URL.createObjectURL(file))
    setImageBusy(true)

    try {
      const updatedCustomer = await uploadCustomerProfileImage(
        customer.id,
        file,
      )

      setCustomer(updatedCustomer)
      setPreviewUrl(null)
      setImageLoadFailed(false)
      window.dispatchEvent(new Event("northstar:profile-image-updated"))
      setImageMessage("Profile picture updated successfully.")
    } catch (uploadError) {
      setPreviewUrl(null)
      setImageError(
        uploadError instanceof Error
          ? uploadError.message
          : "Unable to update your profile picture.",
      )
    } finally {
      setImageBusy(false)
    }
  }

  async function handleRemoveProfileImage() {
    if (!customer?.profileImageUrl || imageBusy) {
      return
    }

    setImageError("")
    setImageMessage("")
    setImageBusy(true)

    try {
      await removeCustomerProfileImage()

      setPreviewUrl(null)
      setImageLoadFailed(false)
      setCustomer({
        ...customer,
        profileImageUrl: null,
      })
      window.dispatchEvent(new Event("northstar:profile-image-updated"))
      setImageMessage("Profile picture removed.")
    } catch (removeError) {
      setImageError(
        removeError instanceof Error
          ? removeError.message
          : "Unable to remove your profile picture.",
      )
    } finally {
      setImageBusy(false)
    }
  }

  async function handleSignOut() {
    await signOutCustomer()
    window.location.assign("/")
  }

  if (loading) {
    return (
      <section className="customer-profile">
        <div className="customer-profile__loading">
          <p>Loading your profile…</p>
        </div>
      </section>
    )
  }

  if (!customer) {
    return (
      <section className="customer-profile">
        <div className="customer-profile__error" role="alert">
          <strong>Unable to load your profile</strong>
          <p>
            {imageError || "Your customer profile is unavailable."}
          </p>
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

  const initials =
    `${customer.firstName.charAt(0)}${customer.lastName.charAt(0)}`.toUpperCase()

  const profileImageSrc = previewUrl ?? (customer.profileImageUrl
    ? `${customer.profileImageUrl}?v=${encodeURIComponent(customer.id)}&t=${Date.now()}`
    : null)

  return (
    <section className="customer-profile">
      <header className="customer-profile__hero">
        <div>
          <span className="customer-profile__eyebrow">
            CUSTOMER BANKING
          </span>
          <h1>Profile</h1>
          <p>
            Review and manage the personal information associated with
            your NorthStarBank customer profile.
          </p>
        </div>
      </header>

      <div className="customer-profile__grid">
        <section className="customer-profile__card customer-profile__identity">
          <div className="customer-profile__identity-main">
            <div className="customer-profile__avatar-wrap">
              <div className="customer-profile__avatar">
                {profileImageSrc && !imageLoadFailed ? (
                  <img
                    src={profileImageSrc}
                    alt={`${customer.firstName} ${customer.lastName}`}
                    onError={() => {
                      setImageLoadFailed(true)
                      setPreviewUrl(null)
                    }}
                  />
                ) : (
                  initials
                )}
              </div>

              <button
                className="customer-profile__avatar-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={imageBusy}
                aria-label="Change profile picture"
                title="Change profile picture"
              >
                <Camera size={15} />
              </button>

              <input
                ref={fileInputRef}
                className="customer-profile__file-input"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleProfileImageChange}
                disabled={imageBusy}
              />
            </div>

            <div className="customer-profile__identity-copy">
              <span>Customer</span>
              <h2>
                {customer.firstName} {customer.lastName}
              </h2>
              <p>Customer #{customer.customerNumber}</p>
            </div>
          </div>

          <span
            className={`customer-profile__status customer-profile__status--${customer.status}`}
          >
            {customer.status}
          </span>
        </section>

        <section className="customer-profile__card customer-profile__image-card">
          <div className="customer-profile__section-heading">
            <ImagePlus size={19} />
            <div>
              <span>PROFILE PICTURE</span>
              <h2>Personalize your profile</h2>
            </div>
          </div>

          <p className="customer-profile__muted-copy">
            Use a clear personal photo. JPEG, PNG, and WebP images up
            to 5 MB are supported.
          </p>

          <div className="customer-profile__image-actions">
            <button
              className="customer-profile__primary-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={imageBusy}
            >
              <Camera size={16} />
              {imageBusy ? "Updating…" : "Change picture"}
            </button>

            {customer.profileImageUrl ? (
              <button
                className="customer-profile__secondary-button customer-profile__secondary-button--danger"
                type="button"
                onClick={() => void handleRemoveProfileImage()}
                disabled={imageBusy}
              >
                <Trash2 size={16} />
                Remove
              </button>
            ) : null}
          </div>

          {imageMessage ? (
            <div className="customer-profile__image-message" role="status">
              <CheckCircle2 size={16} />
              <span>{imageMessage}</span>
            </div>
          ) : null}

          {imageError ? (
            <div className="customer-profile__image-error" role="alert">
              {imageError}
            </div>
          ) : null}
        </section>

        <section className="customer-profile__card">
          <div className="customer-profile__section-heading">
            <UserRound size={19} />
            <div>
              <span>PERSONAL INFORMATION</span>
              <h2>Contact details</h2>
            </div>
          </div>

          <div className="customer-profile__details">
            <div>
              <span>Full name</span>
              <strong>
                {customer.firstName} {customer.lastName}
              </strong>
            </div>

            <div>
              <span>Email address</span>
              <strong>
                <Mail size={16} />
                {customer.email}
              </strong>
            </div>

            <div>
              <span>Phone number</span>
              <strong>
                <Phone size={16} />
                {customer.phone || "Not provided"}
              </strong>
            </div>

            <div>
              <span>Customer number</span>
              <strong>{customer.customerNumber}</strong>
            </div>

            <div>
              <span>Account status</span>
              <strong>{customer.status}</strong>
            </div>

            <div>
              <span>Customer role</span>
              <strong>{customer.role}</strong>
            </div>
          </div>
        </section>

        <section className="customer-profile__card">
          <div className="customer-profile__section-heading">
            <ShieldCheck size={19} />
            <div>
              <span>ACCOUNT SECURITY</span>
              <h2>Security settings</h2>
            </div>
          </div>

          <div className="customer-profile__security">
            <div>
              <strong>Secure authentication</strong>
              <p>
                Your customer session is protected by an HttpOnly
                secure session cookie.
              </p>
            </div>

            <Link to="/customer/security">
              Review security
            </Link>
          </div>

          <div className="customer-profile__security">
            <div>
              <strong>Password and multi-factor authentication</strong>
              <p>
                Manage your password and available security controls
                from the dedicated security page.
              </p>
            </div>

            <Link to="/customer/security">
              Security controls
            </Link>
          </div>
        </section>

        <section className="customer-profile__card">
          <div className="customer-profile__section-heading">
            <ShieldCheck size={19} />
            <div>
              <span>SESSION</span>
              <h2>Account access</h2>
            </div>
          </div>

          <p className="customer-profile__session-copy">
            You are signed in to the NorthStarBank customer portal.
            Sign out when you are finished using a shared or public
            device.
          </p>

          <button
            className="customer-profile__signout"
            type="button"
            onClick={() => void handleSignOut()}
          >
            Sign out securely
          </button>
        </section>
      </div>
    </section>
  )
}
