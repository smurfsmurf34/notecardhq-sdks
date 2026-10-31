// Shapes of the notecardHQ notes API (https://app.notecardhq.com/api/v1).
// Mirrors the server's OpenAPI document (GET /api/v1/openapi.json) and the
// note it returns from POST /notes, GET /notes/{id}, GET /notes/recent and
// every webhook event.

/** A postal address. `country` is ISO 3166-1 alpha-2 and defaults to "US". */
export interface Address {
  firstName: string;
  lastName?: string;
  businessName?: string;
  address1: string;
  address2?: string;
  city: string;
  /** Required for US addresses. */
  state?: string;
  /** Required for US addresses. */
  postalCode?: string;
  /** ISO 3166-1 alpha-2, e.g. "US", "GB", "BR". Defaults to "US". */
  country?: string;
}

/** Handwriting names the API accepts. Your workspace's docs list the ones its robots write. */
export type WritingStyle =
  | "Cautious Alfred"
  | "Bold Brian"
  | "Serious Sue"
  | "Nerdy Ned"
  | "Chill Carl"
  | "Doctor Dan"
  | "Cursive Caroline";

/** The body of POST /notes. Send `content`, or `context` to have the note written from it. */
export interface CreateNoteParams {
  recipient: Address;
  /** The complete note (greeting and sign-off included), 1 to 500 characters, written exactly as sent. */
  content?: string;
  /** Anything you want stored with the note (at most 100 fields, 8 KB). Never written on the card. */
  context?: Record<string, unknown>;
  /** Your ID for the recipient, e.g. a user or customer ID. 1 to 200 characters. */
  externalId?: string;
  /** Copy template slug, used when the note is written from `context`. */
  template?: string;
  writingStyle?: WritingStyle;
  /** Per-note return address; defaults to the one in your workspace settings. */
  returnAddress?: Address;
  /** LetterTrack mail tracking, US destinations only (billed extra). */
  letterTracking?: boolean;
  /** Workspaces with scheduled sends: "YYYY-MM-DD" in the workspace time zone, at most 365 days ahead. */
  sendOn?: string | null;
  /** Workspaces with a holdout group: `false` never holds this recipient out. `true` is refused. */
  holdout?: false;
  cardId?: string;
}

export interface CreateNoteOptions {
  /**
   * One stable key per event, e.g. `first-sale:${userId}`. The same key and body
   * return the same note; the same key with a different body is a 409.
   * Required by standard workspaces (400 without it); recommended everywhere.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export type NoteStatus =
  | "scheduled"
  | "drafting"
  | "needs_review"
  | "created"
  | "card_printed"
  | "card_dispatched"
  | "cancelled";

/** A note as the API returns it. */
export interface Note {
  id: string;
  status: NoteStatus;
  /** Present (true) only on notes made with a test key. Test notes are never written, mailed or billed. */
  test?: true;
  /** Present (true) only when the recipient is in your holdout group (status is cancelled). */
  holdout?: true;
  /** Present on scheduled notes: the date it will be mailed. */
  sendOn?: string;
  /** Present once personal data was replaced by "[redacted]". Unix ms. */
  redactedAt?: number;
  externalId: string | null;
  recipient: Address;
  returnAddress?: Address;
  /** The note as it will be written. */
  content: string | null;
  contentSource: string | null;
  template: { slug: string; version: number | null } | null;
  context: Record<string, unknown> | null;
  letterTracking: boolean;
  trackingReference: string | null;
  pricing: {
    currency: string;
    cardCents: number;
    trackingCents: number;
    postageIncluded: boolean;
    monthlyVolumeEligible: boolean;
    volumeMonth: string | null;
  };
  /** Unix ms when mailed. */
  sentAt: number | null;
  /** Unix ms. */
  createdAt: number;
  /** Workspaces with proof images: the proof's URL, null until ready. Not on the POST response. */
  proofUrl?: string | null;
}

export interface RecentNote extends Note {
  /** Unix ms of the note's last status change. */
  updatedAt: number;
}

export interface ListRecentParams {
  /** 1 to 100 notes per page. Defaults to 25. */
  limit?: number;
  /** Only notes whose status changed at or after this time. A Date or an ISO 8601 string with a time zone. */
  updatedSince?: Date | string;
  /** `nextCursor` of the previous page. */
  cursor?: string;
}

export interface RecentNotesPage {
  notes: RecentNote[];
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

/** POST /redactions: at least one field. Up to 100 noteIds and 100 idempotencyKeys. */
export interface RedactionParams {
  noteIds?: string[];
  idempotencyKeys?: string[];
  /** Every note carrying this externalId. */
  externalId?: string;
}

export interface RedactionResult {
  matched: number;
  redacted: number;
  cancelled: number;
  alreadyRedacted: number;
  pendingMailing: number;
  notFound: number;
}

export interface HoldoutReportParams {
  /** "YYYY-MM-DD". Defaults to 12 months ago. */
  from?: string;
  /** "YYYY-MM-DD". Defaults to today. At most two years after `from`. */
  to?: string;
}

export interface HoldoutReport {
  from: string;
  to: string;
  holdoutPercent?: number;
  test?: true;
  totals: { card: number; holdout: number };
  months: Array<{
    month: string;
    card: number;
    holdout: number;
    cardExternalIds: string[];
    holdoutExternalIds: string[];
  }>;
  truncated?: true;
}

/** GET /notes: the machine-readable API summary. Its fields depend on the workspace. */
export interface ApiDescription {
  name: string;
  version: number;
  docs: string;
  endpoints: Record<string, string>;
  [key: string]: unknown;
}

export type WebhookEventType =
  | "note.created"
  | "note.needs_review"
  | "note.card_printed"
  | "note.card_dispatched"
  | "note.cancelled"
  | "note.rendered"
  | "note.scheduled"
  | "note.released"
  | "note.redacted";

export interface WebhookEvent {
  /** Unique per event: ignore repeats. */
  id: string;
  type: WebhookEventType;
  /** Unix seconds. Delivery order is not guaranteed; use this. */
  created: number;
  /** True for events about test-key notes. */
  test: boolean;
  /** The note exactly as GET /notes/{id} returns it. */
  data: Note;
}
