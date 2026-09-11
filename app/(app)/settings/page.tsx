import { BusinessHoursForm } from "@/components/settings/business-hours-form"
import { BusinessTypeSection } from "@/components/settings/business-type-section"
import { EnvStatusSection } from "@/components/settings/env-status-section"
import { GoogleCalendarSection } from "@/components/settings/google-calendar-section"
import { InboundSection } from "@/components/settings/inbound-section"
import { PhoneCallsSection } from "@/components/settings/phone-calls-section"
import { SettingsGroup } from "@/components/settings/section"
import { WidgetSection } from "@/components/settings/widget-section"
import { listNumbers } from "@/lib/inbound/numbers"
import { QuotaSection } from "@/components/settings/quota-section"
import { ServicesSection } from "@/components/settings/services-section"
import { requireBusiness } from "@/lib/business/require-business"
import {
  asGoogleStatus,
  googleConnection,
  GOOGLE_STATUS_PARAM,
} from "@/lib/google/connection"
import { envStatus, RETELL_FROM_NUMBER } from "@/lib/settings/env-status"
import { loadSettings } from "@/lib/settings/load-settings"
import { businessQuota } from "@/lib/quota"

/**
 * Settings — everything about a Business that is not an Appointment
 * (SPEC.md §11.3).
 *
 * A Server Component that does the reading and hands each section exactly what
 * it renders. Three separate reads rather than one `loadSettings` returning all
 * of it: Business Hours and Services come from the database, the Google
 * connection is derived from columns already on the `businesses` row, and the
 * environment audit is `process.env` — different sources with different
 * lifetimes, and folding them into one function would have made that function
 * impossible to test without a database *and* a mutated environment.
 *
 * **One 720px column, in five named groups.** This screen is long — nine things
 * to change, most of them rarely — and its old shape was nine full-width cards
 * stretched across 1150px, which made an eleven-word sentence about Google run
 * the width of a desktop monitor and gave an admin-only panel exactly the same
 * frame as the opening hours. So: a readable measure, and plain headings
 * (Business · Maya · Integrations · Account · Admin) that say what a section is
 * for before you read it. Admin is a group of its own and says who can see it.
 *
 * **Each section owns its own heading and copy**; this file owns only the
 * groups, their order and the data each section needs. The alternative — titles
 * passed down as props from here — was tried and read worse, because a section
 * that renders its own `PageHeader` is the only one that can describe itself
 * accurately (the Google one has three different descriptions depending on
 * whether the integration is configured at all).
 *
 * `requireBusiness()` is React-`cache()`d and `app/(app)/layout.tsx` has already
 * called it, so the Business costs no second query here.
 *
 * **Business Hours and Services are the two inputs Availability is computed
 * from** (CONTEXT.md), which is why this screen exists before #6 rather than
 * after it: without it, an account is stuck with whatever its Template seeded.
 */
export default async function SettingsPage({
  searchParams,
}: PageProps<"/settings">) {
  const { business } = await requireBusiness()
  const [{ hours, services }, numbers] = await Promise.all([
    loadSettings(business.id),
    listNumbers(business.id),
  ])

  /*
    The Google OAuth callback is a Route Handler, not a Server Action, so it has
    no action state to return — it reports what happened by redirecting back
    here with `?google=<status>`. `asGoogleStatus` is what keeps that from being
    an injection surface: an unrecognised value becomes null and renders
    nothing, rather than being echoed onto the page.
  */
  const status = asGoogleStatus(
    readParam((await searchParams)[GOOGLE_STATUS_PARAM]),
  )

  /*
    Read once, used by both admin-only sections below: the panel lists every
    variable, and the phone switch asks about one of them. Booleans only — see
    `lib/settings/env-status.ts`, which keeps values out of the return type
    entirely.

    Computed for every account, admin or not, and gated at the point of use
    rather than here. That is deliberate and it is safe for one reason only:
    nothing is leaked by *computing* this, only by rendering it, and both
    consumers sit inside the `isAdmin` block below. **Passing `variables` to a
    section outside that block would leak it**, with nothing to stop you — the
    gate is the conditional, not this line.
  */
  const variables = envStatus(process.env)

  return (
    <div className="flex flex-col gap-8">
      <div className="workspace-intro"><div><p className="workspace-eyebrow">MAKE YOURSELF AT HOME</p><h2>Make Callzie yours.</h2><p>A few details help Maya take care of your business the way you would.</p></div></div>
      <div className="workspace-settings">
      <nav className="workspace-settings-nav" aria-label="Settings sections">
        <p>Jump to a section</p>
        <a href="#business">Your business</a><a href="#maya">Maya & calls</a><a href="#integrations">Integrations</a><a href="#account">Account & usage</a>
        {business.isAdmin ? <a href="#admin">Admin</a> : null}
      </nav>
      <div className="workspace-settings-body">
      {/*
        Which business this page is editing, said once at the top. An account has
        one Business today, but the timezone belongs here rather than repeated
        down the screen: every time on this page — opening hours, appointments,
        the hours a call may be placed in — is a wall-clock time in this zone and
        in no other. Not the mono face: an IANA zone name like
        `America/New_York` is a place, not a clock reading.
      */}
      <p className="text-body text-text">
        {business.name}
        <span aria-hidden> · </span>
        <span className="text-text-muted">{business.timezone}</span>
      </p>

      <SettingsGroup title="Business">
        <BusinessHoursForm hours={hours} timezone={business.timezone} />
        <ServicesSection services={services} />
        <BusinessTypeSection businessType={business.businessType} />
      </SettingsGroup>

      <SettingsGroup title="Maya">
        {/*
          Not admin-gated, unlike the phone switch further down. Answering a
          number the business already owns is not the same risk as dialling
          strangers (SPEC.md §3 rule 9) — the caller chose to ring, the cost is
          bounded by the inbound allowance, and the emergency number bounds the
          rest.
        */}
        <InboundSection
          numbers={numbers}
          enabled={business.inboundEnabled}
          emergencyLine={business.emergencyLine}
          quota={business.inboundQuota}
          used={business.inboundCallsUsed}
        />

        {/*
          After the inbound section because it depends on it: the widget reaches
          the same Agent and is refused by the same guards, so answering has to
          be on before the button does anything (issue #45).
        */}
        <WidgetSection
          inboundEnabled={business.inboundEnabled}
          appUrl={process.env.APP_URL ?? ""}
          widgetKey={business.widgetKey}
          origins={business.widgetOrigins}
          dailyCap={business.widgetDailyCap}
        />
      </SettingsGroup>

      <SettingsGroup title="Integrations">
        <GoogleCalendarSection
          connection={googleConnection(business)}
          status={status}
        />
      </SettingsGroup>

      <SettingsGroup title="Account">
        <QuotaSection quota={businessQuota(business)} />
      </SettingsGroup>

      {/*
        Admin only, and gated here rather than inside the components so a
        non-admin's HTML never contains either of them at all — hiding them with
        CSS would still ship the list of which integrations this deployment is
        missing to anyone who can sign up, and signup on this product is open.
        `envStatus` returns booleans only, so even this is one step removed from
        a secret; the gate is the other step.

        The phone switch is here for a second reason on top of that one. It is
        the control that decides whether this account may dial a real phone
        (SPEC.md §3 rule 9), so it belongs to nobody who can merely sign up. The
        gate is not the only thing stopping them — `setPhoneCallsEnabled` scopes
        the write to admins inside its own UPDATE — but a control an account
        cannot use should not be on its screen either.
      */}
      {business.isAdmin ? (
        <SettingsGroup title="Admin" note="Only admin accounts see this.">
          <PhoneCallsSection
            enabled={business.phoneCallsEnabled}
            fromNumberSet={
              variables.find(
                (variable) => variable.name === RETELL_FROM_NUMBER,
              )?.set ?? false
            }
          />
          <EnvStatusSection variables={variables} />
        </SettingsGroup>
      ) : null}
      </div>
      </div>
    </div>
  )
}

/**
 * A search param as a single string.
 *
 * A repeated query key (`?google=a&google=b`) arrives as an array, so this
 * collapses to the first entry rather than letting `string[]` reach a function
 * typed for `string | null`.
 */
function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}
