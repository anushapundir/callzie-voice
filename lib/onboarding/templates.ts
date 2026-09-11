import type { AppointmentStatus, BusinessType } from "@/lib/db/schema";

/**
 * The four Templates — one per Business Type (SPEC.md §4).
 *
 * A Template is what an account gets by picking a Business Type: the starting
 * Business Hours, the Services on offer, and the example Appointments that make
 * Overview a working dashboard rather than an empty table on the first render.
 * An account **selects** one and never authors one (SPEC.md §14 rule 5), which
 * is why this is a checked-in constant and not a database table.
 *
 * `TEMPLATES` is a `Record<BusinessType, Template>` on purpose: it is what makes
 * "exactly four, no gaps" a compile-time property rather than a test. Issue #9
 * adds the Retell Agent prompt, voice persona and begin message as fields here
 * and iterates this record to create one Agent per Business Type — key Agents
 * off `BusinessType` and nothing else. No placeholder prompt field ships now:
 * an empty prompt string in a codebase whose §14 rule 5 is "never lets a user
 * author an agent prompt" reads exactly wrong.
 *
 * No icons here either. This module is imported by a Server Action and by
 * vitest, so it stays free of React; the `BusinessType → LucideIcon` map lives
 * with the picker that renders it.
 */

/** One weekday's opening window. Wall-clock local time, per SPEC.md §5. */
export type TemplateHours = {
  /** 0 = Sunday, matching `business_hours.weekday`. */
  weekday: number;
  /** `"09:00"` — a `time` column, never an absolute timestamp. */
  opensAt: string;
  closesAt: string;
};

export type TemplateService = {
  name: string;
  durationMinutes: number;
};

export type TemplateAppointment = {
  name: string;
  /**
   * E.164 (SPEC.md §3 rule 10), and always inside the reserved fictional
   * `+1 202 555 01xx` range. Not fussiness: the product's entire job is to dial
   * the numbers in this table, and #11/#19 point a real dialler at exactly these
   * rows. A plausible-looking real number here is a call to a stranger.
   */
  phoneE164: string;
  /** Must match a `TemplateService.name` — asserted in `templates.test.ts`. */
  serviceName: string;
  /** Index into the Business's next open days, counted strictly after today. */
  openDay: number;
  /**
   * Start offset from that day's opening time, in minutes — not a wall clock.
   *
   * A Template's opening window differs by weekday (tutoring runs 16:00–20:00
   * on weekdays but 10:00–14:00 on Saturday), and which weekday `openDay`
   * resolves to depends on when the account signs up. A fixed `"16:00"` would
   * therefore fall outside Business Hours for anyone who onboarded on a Friday,
   * silently seeding data that violates SPEC.md §14 rule 1. An offset from
   * opening fits every window the Template declares, which `templates.test.ts`
   * checks against the shortest one.
   */
  minutesAfterOpen: number;
  status: AppointmentStatus;
};

export type Template = {
  businessType: BusinessType;
  /** The UI string — `home_services` is shown as "Home services". */
  label: string;
  /** One sentence, sentence case, on the picker card (SPEC.md §11.4). */
  description: string;
  hours: readonly TemplateHours[];
  services: readonly TemplateService[];
  appointments: readonly TemplateAppointment[];
};

/** Mon–Fri, or any contiguous run, at one opening window. */
function weekdays(
  from: number,
  to: number,
  opensAt: string,
  closesAt: string,
): TemplateHours[] {
  const hours: TemplateHours[] = [];
  for (let weekday = from; weekday <= to; weekday++) {
    hours.push({ weekday, opensAt, closesAt });
  }
  return hours;
}

export const TEMPLATES: Record<BusinessType, Template> = {
  clinic: {
    businessType: "clinic",
    label: "Clinic",
    description:
      "Dental, medical or physio practices booking check-ups and treatments.",
    hours: weekdays(1, 5, "09:00", "17:00"),
    services: [
      { name: "Check-up", durationMinutes: 30 },
      { name: "Cleaning", durationMinutes: 45 },
      { name: "Consultation", durationMinutes: 20 },
    ],
    appointments: [
      {
        name: "Priya Raman",
        phoneE164: "+12025550110",
        serviceName: "Cleaning",
        openDay: 0,
        minutesAfterOpen: 0,
        status: "pending",
      },
      {
        name: "Daniel Okafor",
        phoneE164: "+12025550111",
        serviceName: "Check-up",
        openDay: 0,
        minutesAfterOpen: 90,
        status: "confirmed",
      },
      {
        name: "Mei Lin",
        phoneE164: "+12025550112",
        serviceName: "Consultation",
        openDay: 0,
        minutesAfterOpen: 300,
        status: "pending",
      },
      {
        name: "Tomás Guerrero",
        phoneE164: "+12025550113",
        serviceName: "Cleaning",
        openDay: 1,
        minutesAfterOpen: 0,
        status: "pending",
      },
      {
        name: "Aisha Bello",
        phoneE164: "+12025550114",
        serviceName: "Check-up",
        openDay: 1,
        minutesAfterOpen: 390,
        status: "pending",
      },
    ],
  },

  salon: {
    businessType: "salon",
    label: "Salon",
    description: "Hair, beauty and nail studios running a chair-by-chair diary.",
    hours: weekdays(2, 6, "10:00", "19:00"),
    services: [
      { name: "Haircut", durationMinutes: 45 },
      { name: "Colour", durationMinutes: 90 },
      { name: "Blow-dry", durationMinutes: 30 },
    ],
    appointments: [
      {
        name: "Nadia Haddad",
        phoneE164: "+12025550120",
        serviceName: "Haircut",
        openDay: 0,
        minutesAfterOpen: 30,
        status: "pending",
      },
      {
        name: "Grace Mwangi",
        phoneE164: "+12025550121",
        serviceName: "Colour",
        openDay: 0,
        minutesAfterOpen: 120,
        status: "confirmed",
      },
      {
        name: "Iris Delacroix",
        phoneE164: "+12025550122",
        serviceName: "Blow-dry",
        openDay: 0,
        minutesAfterOpen: 300,
        status: "pending",
      },
      {
        name: "Farah Siddiqui",
        phoneE164: "+12025550123",
        serviceName: "Haircut",
        openDay: 1,
        minutesAfterOpen: 60,
        status: "pending",
      },
      {
        name: "Leah Bergström",
        phoneE164: "+12025550124",
        serviceName: "Colour",
        openDay: 1,
        minutesAfterOpen: 240,
        status: "pending",
      },
    ],
  },

  home_services: {
    businessType: "home_services",
    label: "Home services",
    description: "Cleaners, plumbers and electricians visiting customers on site.",
    hours: weekdays(1, 6, "08:00", "18:00"),
    services: [
      { name: "Deep clean", durationMinutes: 120 },
      { name: "Standard clean", durationMinutes: 90 },
      { name: "Repair visit", durationMinutes: 60 },
    ],
    appointments: [
      {
        name: "Marcus Webb",
        phoneE164: "+12025550130",
        serviceName: "Deep clean",
        openDay: 0,
        minutesAfterOpen: 30,
        status: "pending",
      },
      {
        name: "Sofia Almeida",
        phoneE164: "+12025550131",
        serviceName: "Repair visit",
        openDay: 0,
        minutesAfterOpen: 210,
        status: "confirmed",
      },
      {
        name: "Kenji Watanabe",
        phoneE164: "+12025550132",
        serviceName: "Standard clean",
        openDay: 0,
        minutesAfterOpen: 360,
        status: "pending",
      },
      {
        name: "Ruth Adeyemi",
        phoneE164: "+12025550133",
        serviceName: "Standard clean",
        openDay: 1,
        minutesAfterOpen: 60,
        status: "pending",
      },
      {
        name: "Callum Doyle",
        phoneE164: "+12025550134",
        serviceName: "Repair visit",
        openDay: 1,
        minutesAfterOpen: 300,
        status: "pending",
      },
    ],
  },

  tutoring: {
    businessType: "tutoring",
    label: "Tutoring",
    description: "Tutors and test-prep centres teaching after school and weekends.",
    hours: [...weekdays(1, 5, "16:00", "20:00"), { weekday: 6, opensAt: "10:00", closesAt: "14:00" }],
    services: [
      { name: "Maths hour", durationMinutes: 60 },
      { name: "Science hour", durationMinutes: 60 },
      { name: "Exam prep", durationMinutes: 90 },
    ],
    appointments: [
      {
        name: "Ravi Menon",
        phoneE164: "+12025550140",
        serviceName: "Maths hour",
        openDay: 0,
        minutesAfterOpen: 0,
        status: "pending",
      },
      {
        name: "Elena Popescu",
        phoneE164: "+12025550141",
        serviceName: "Exam prep",
        openDay: 0,
        minutesAfterOpen: 90,
        status: "confirmed",
      },
      {
        name: "Jonah Feldman",
        phoneE164: "+12025550142",
        serviceName: "Science hour",
        openDay: 1,
        minutesAfterOpen: 0,
        status: "pending",
      },
      {
        name: "Amara Nwosu",
        phoneE164: "+12025550143",
        serviceName: "Maths hour",
        openDay: 1,
        minutesAfterOpen: 60,
        status: "pending",
      },
      {
        name: "Theo Lindqvist",
        phoneE164: "+12025550144",
        serviceName: "Exam prep",
        openDay: 1,
        minutesAfterOpen: 135,
        status: "pending",
      },
    ],
  },
};

/** The Template a Business Type ships with. */
export function templateFor(businessType: BusinessType): Template {
  return TEMPLATES[businessType];
}
