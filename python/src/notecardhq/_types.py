"""Shapes of the notecardHQ notes API. Requests and responses are plain dicts;
these TypedDicts describe them for type checkers."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict

NoteStatus = Literal[
    "scheduled", "drafting", "needs_review", "created", "card_printed", "card_dispatched", "cancelled"
]

WritingStyle = Literal[
    "Cautious Alfred",
    "Bold Brian",
    "Serious Sue",
    "Nerdy Ned",
    "Chill Carl",
    "Doctor Dan",
    "Cursive Caroline",
]

WebhookEventType = Literal[
    "note.created",
    "note.needs_review",
    "note.card_printed",
    "note.card_dispatched",
    "note.cancelled",
    "note.rendered",
    "note.scheduled",
    "note.released",
    "note.redacted",
]


class _AddressRequired(TypedDict):
    firstName: str
    address1: str
    city: str


class Address(_AddressRequired, total=False):
    """A postal address. ``state`` and ``postalCode`` are required in the US;
    ``country`` is ISO 3166-1 alpha-2 and defaults to "US"."""

    lastName: str
    businessName: str
    address2: str
    state: str
    postalCode: str
    country: str


class _NoteParamsRequired(TypedDict):
    recipient: Address


class NoteParams(_NoteParamsRequired, total=False):
    """The JSON body of POST /notes. Send ``content``, or ``context`` to have the note written from it."""

    content: str
    """The complete note, 1 to 500 characters, written exactly as sent."""
    context: Dict[str, Any]
    """Stored with the note (at most 100 fields, 8 KB). Never written on the card."""
    externalId: str
    template: str
    writingStyle: WritingStyle
    returnAddress: Address
    letterTracking: bool
    sendOn: Optional[str]
    """Workspaces with scheduled sends: "YYYY-MM-DD", at most 365 days ahead."""
    holdout: Literal[False]
    cardId: str


class Pricing(TypedDict):
    currency: str
    cardCents: int
    trackingCents: int
    postageIncluded: bool
    monthlyVolumeEligible: bool
    volumeMonth: Optional[str]


class Template(TypedDict):
    slug: str
    version: Optional[int]


class _NoteRequired(TypedDict):
    id: str
    status: NoteStatus


class Note(_NoteRequired, total=False):
    """A note as the API returns it. ``test``, ``holdout``, ``sendOn``,
    ``redactedAt`` and ``proofUrl`` are present only when they apply."""

    test: Literal[True]
    holdout: Literal[True]
    sendOn: str
    redactedAt: float
    externalId: Optional[str]
    recipient: Address
    returnAddress: Address
    content: Optional[str]
    contentSource: Optional[str]
    template: Optional[Template]
    context: Optional[Dict[str, Any]]
    letterTracking: bool
    trackingReference: Optional[str]
    pricing: Pricing
    sentAt: Optional[float]
    createdAt: float
    proofUrl: Optional[str]


class RecentNote(Note, total=False):
    updatedAt: float


class RecentNotesPage(TypedDict):
    notes: List[RecentNote]
    nextCursor: Optional[str]


class RedactionResult(TypedDict):
    matched: int
    redacted: int
    cancelled: int
    alreadyRedacted: int
    pendingMailing: int
    notFound: int


class HoldoutMonth(TypedDict):
    month: str
    card: int
    holdout: int
    cardExternalIds: List[str]
    holdoutExternalIds: List[str]


# "from" is a Python keyword, hence the functional form.
HoldoutReport = TypedDict(
    "HoldoutReport",
    {
        "from": str,
        "to": str,
        "holdoutPercent": int,
        "test": Literal[True],
        "totals": Dict[str, int],
        "months": List[HoldoutMonth],
        "truncated": Literal[True],
    },
    total=False,
)


class WebhookEvent(TypedDict):
    id: str
    type: WebhookEventType
    created: int
    test: bool
    data: Note
