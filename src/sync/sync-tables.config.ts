export interface ColumnMapping {
  mysql: string;
  pg: string;
  quotePg?: boolean;
}

export type ColumnDef = string | ColumnMapping;

export interface TableSyncConfig {
  mysqlTable: string;
  pgTable: string;
  conflictKeys: string[];
  columns: ColumnDef[];
  // optional per-row transform hook, e.g. to coerce empty strings to null
  transform?: (row: Record<string, any>) => Record<string, any>;
  // set to false to skip delete-propagation for this table (default: true,
  // meaning rows deleted in MySQL get deleted in Postgres too)
  syncDeletes?: boolean;
  // Optional full SELECT statement (with JOINs, aliases, etc.) used
  // instead of the default `SELECT <columns> FROM <mysqlTable>`. Must:
  //   - alias every selected column to match the `mysql` name used in
  //     `columns` above (so row[c.mysqlCol] resolves correctly)
  //   - include a deterministic ORDER BY (for stable LIMIT/OFFSET paging)
  //   - end with `LIMIT ? OFFSET ?`
  customQuery?: string;
}

const passthrough = (row: Record<string, any>) => row;

export const TABLE_SYNC_CONFIGS: TableSyncConfig[] = [
  {
    mysqlTable: 'events',
    pgTable: 'events',
    conflictKeys: ['id'],
    columns: [
      'id', 'ev_desc', 'ev_brief', 'ev_owner', 'ev_url', 'ev_url_id',
      'is_done', 'target_invitee', 'ev_privacy', 'category_id', 'type_id',
      'ev_startdate', 'ev_enddate', 'ev_venue', 'ev_address', 'detail_venue',
      'feedback_link', 'ev_lat', 'ev_long', 'status', 'poster',
      'poster_mobile', 'bizmatch_open', 'multiple_session_entry', 'pre_reg',
      'ev_rate', 'ev_visited', 'created_date', 'last_update',
      // Event key 6-digit untuk login exhibitor app (event key + no. HP ->
      // OTP WA). select:false di entity Postgres-nya - lihat event.entity.ts.
      'ev_token',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'location_address',
    pgTable: 'location_address',
    conflictKeys: ['id', 'events_id'],
    columns: [
      'id', 'events_id', 'ev_venue', 'ev_address', 'ev_lat', 'ev_long',
      'default_address',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'venue_space',
    pgTable: 'venue_space',
    conflictKeys: ['id', 'venue_id', 'events_id'],
    columns: [
      'id', 'venue_id', 'events_id', 'space_name', 'space_details', 'logo',
      'space_type', 'default_space',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'new_agenda',
    pgTable: 'new_agenda',
    conflictKeys: ['id', 'events_id'],
    columns: [
      'id', 'events_id', 'agenda_name', 'alias_name', 'agenda_date',
      'prime_agenda',
      { mysql: 'showOnMedia', pg: 'showOnMedia', quotePg: true },
      'venue_id', 'sort_no',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'new_track',
    pgTable: 'new_track',
    conflictKeys: ['id', 'agenda_id', 'events_id'],
    columns: [
      'id', 'agenda_id', 'events_id', 'track_name', 'alias_name', 'logo',
      'prime_track',
      { mysql: 'showOnMedia', pg: 'showOnMedia', quotePg: true },
      'sort_no',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'new_session',
    pgTable: 'new_session',
    conflictKeys: ['id', 'track_id', 'agenda_id', 'events_id'],
    columns: [
      'id', 'track_id', 'agenda_id', 'events_id', 'session_topic',
      'session_brief', 'start_time', 'end_time', 'poster', 'prime_session',
      { mysql: 'showOnMedia', pg: 'showOnMedia', quotePg: true },
      'quota', 'youtube_livestream', 'show_on_ticket', 'show_on_rundown',
      'moderator', 'session_category', 'sort_no', 'minimum_stay',
      'souvenir_redeem_toggle', 'fnb_redeem_toggle',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'events_speakers',
    pgTable: 'events_speakers',
    conflictKeys: ['events_id', 'speaker_id'],
    columns: [
      'events_id', 'speaker_id', 'speaker_name', 'speaker_email',
      'speaker_phone', 'job_title', 'approval_status',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'session_speaker',
    pgTable: 'session_speaker',
    conflictKeys: ['session_id', 'track_id', 'agenda_id', 'events_id', 'speaker_id'],
    columns: ['session_id', 'track_id', 'agenda_id', 'events_id', 'speaker_id'],
    transform: passthrough,
  },
  {
    mysqlTable: 'guests_ticket',
    pgTable: 'guests_ticket',
    conflictKeys: ['guests_id', 'events_id', 'id', 'ticket_id'],
    columns: [
      'guests_id', 'events_id', 'id', 'ticket_id', 'fullname', 'email',
      'token', 'created', 'track_id', 'session_id', 'paid', 'order_id',
      'approval_status', 'is_prereg', 'country_code', 'phone',
      'profile_score', 'guest_title', 'promo_id', 'normal_price',
      'discount_amount', 'companytype_id', 'profession_id', 'position_id',
      'division_id', 'company_name', 'updated_at',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'checkin_booth',
    pgTable: 'checkin_booth',
    conflictKeys: ['events_id', 'exhibitor_id', 'venue_id', 'space_id', 'guests_id', 'company_id', 'member_id'],
    columns: [
      'events_id', 'exhibitor_id', 'venue_id', 'space_id', 'guests_id',
      'company_id', 'member_id', 'scan_by', 'checkin_datetime',
      'last_update', 'souvenir', 'visitor_notes',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'events_chat',
    pgTable: 'events_chat',
    conflictKeys: ['events_id', 'chat_id'],
    columns: [
      'events_id', 'chat_id', 'chat_name', 'created', 'created_by',
      'member_id',
      { mysql: 'lastSender', pg: 'lastSender', quotePg: true },
      'message',
      { mysql: 'totalPost', pg: 'totalPost', quotePg: true },
      { mysql: 'userRead', pg: 'userRead', quotePg: true },
      'unread',
      { mysql: 'adminToken', pg: 'adminToken', quotePg: true },
      'usertype_id', 'com_direction', 'last_update',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'events_chatmember_v2',
    pgTable: 'events_chatmember_v2',
    conflictKeys: ['events_id', 'chat_id', 'chatmember_id'],
    columns: [
      'events_id', 'chat_id', 'chatmember_id', 'guests_id', 'member_id',
      { mysql: 'userRead', pg: 'userRead', quotePg: true },
      'unread', 'guest_level', 'usertype_id', 'company_id',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'events_meeting_v2',
    pgTable: 'events_meeting_v2',
    conflictKeys: ['id', 'events_id'],
    columns: [
      'id', 'events_id', 'meeting_title', 'start_datetime', 'end_datetime',
      'notes', 'approval_status', 'venue_id', 'space_id',
      { mysql: 'Status', pg: 'Status', quotePg: true },
      'initiated_by', 'initiator_id', 'initiator_member_id',
      'com_direction', 'last_update', 'meeting_location', 'is_done',
      'actual_startdatetime', 'actual_enddatetime', 'agenda_id',
      'meeting_timeslot', 'meeting_score',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'meeting_member_v2',
    pgTable: 'meeting_member_v2',
    conflictKeys: ['events_id', 'guests_id', 'member_guests_id', 'meeting_id'],
    columns: [
      'events_id', 'guests_id', 'member_guests_id', 'meeting_id',
      'guest_level', 'status_notif', 'approval_status', 'usertype_id',
      'company_id', 'guest_fullname', 'member_fullname', 'company_name',
    ],
    // guests_ticket has multiple rows per (events_id, guests_id) — a
    // guest can have several ticket rows for the same event — so we
    // de-duplicate with ROW_NUMBER() before joining, taking the lowest
    // `id` as the representative row. exhibitor_company is 1 row per
    // (events_id, id) so it joins cleanly without de-dup.
    customQuery: `
      SELECT
        mm.events_id AS events_id,
        mm.guests_id AS guests_id,
        mm.member_guests_id AS member_guests_id,
        mm.meeting_id AS meeting_id,
        mm.guest_level AS guest_level,
        mm.status_notif AS status_notif,
        mm.approval_status AS approval_status,
        mm.usertype_id AS usertype_id,
        mm.company_id AS company_id,
        gt.fullname AS guest_fullname,
        gm.fullname AS member_fullname,
        ec.company_name AS company_name
      FROM meeting_member_v2 mm
      LEFT JOIN (
        SELECT guests_id, events_id, fullname,
               ROW_NUMBER() OVER (PARTITION BY guests_id, events_id ORDER BY id) AS rn
        FROM guests_ticket
      ) gt ON gt.events_id = mm.events_id AND gt.guests_id = mm.guests_id AND gt.rn = 1
      LEFT JOIN (
        SELECT guests_id, events_id, fullname,
               ROW_NUMBER() OVER (PARTITION BY guests_id, events_id ORDER BY id) AS rn
        FROM guests_ticket
      ) gm ON gm.events_id = mm.events_id AND gm.guests_id = mm.member_guests_id AND gm.rn = 1
      LEFT JOIN exhibitor_company ec ON ec.events_id = mm.events_id AND ec.id = mm.company_id
      ORDER BY mm.events_id, mm.guests_id, mm.member_guests_id, mm.meeting_id
      LIMIT ? OFFSET ?
    `,
    transform: passthrough,
  },
  {
    mysqlTable: 'exhcompany_space',
    pgTable: 'exhcompany_space',
    conflictKeys: ['events_id', 'venue_id', 'space_id', 'company_id'],
    columns: ['events_id', 'venue_id', 'space_id', 'company_id'],
    transform: passthrough,
  },
  {
    mysqlTable: 'product_type',
    pgTable: 'product_type',
    conflictKeys: ['events_id', 'id'],
    columns: ['events_id', 'id', 'deskripsi', 'approval_status', 'bizconcept_id'],
    transform: passthrough,
  },
  {
    mysqlTable: 'exhibitorproduct_has_type',
    pgTable: 'exhibitorproduct_has_type',
    conflictKeys: ['events_id', 'company_id', 'product_id', 'product_type'],
    columns: ['events_id', 'company_id', 'product_id', 'product_type'],
    transform: passthrough,
  },
  {
    mysqlTable: 'company_timeslot',
    pgTable: 'company_timeslot',
    conflictKeys: ['events_id', 'company_id', 'agenda_id', 'time_slot'],
    columns: [
      'events_id', 'company_id', 'agenda_id', 'time_slot', 'last_update',
      'is_enabled', 'booked',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'meeting_location_v2',
    pgTable: 'meeting_location_v2',
    conflictKeys: ['events_id', 'location_id'],
    columns: ['events_id', 'location_id', 'location_name', 'is_enabled', 'sort_no'],
    transform: passthrough,
  },
  {
    mysqlTable: 'interest_options',
    pgTable: 'interest_options',
    conflictKeys: ['events_id', 'interest_id'],
    columns: [
      'events_id', 'interest_id', 'interest_options', 'sort_no',
      'is_enabled', 'interest_for',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'meeting_interest',
    pgTable: 'meeting_interest',
    conflictKeys: ['events_id', 'meeting_id', 'interest_id'],
    columns: ['events_id', 'meeting_id', 'interest_id'],
    transform: passthrough,
  },
  // --- Ditambahkan: exhibitor_company / exhibitor / exhibitor_product ---
  // Gap ditemukan saat wiring exhibitor app (Sept 2026): apivisitor sudah
  // punya entity untuk 3 tabel ini (Company Detail, Product Catalog) tapi
  // tidak pernah masuk daftar sync - datanya di Postgres jadi statis sejak
  // kapanpun tabel itu dibuat manual pertama kali. Oversight, bukan disengaja.
  {
    mysqlTable: 'exhibitor_company',
    pgTable: 'exhibitor_company',
    conflictKeys: ['events_id', 'id'],
    columns: [
      'events_id', 'id', 'company_name', 'details', 'created', 'logo',
      'approval_status', 'country', 'company_profile_url', 'language_used',
      'last_update', 'company_website',
    ],
    transform: passthrough,
  },
  {
    // MySQL table is `exhibitor` (staff/PIC data), tapi di Postgres sudah
    // dipetakan sebagai `exhibitor_contact` oleh apivisitor
    // (lihat exhibitor.entity.ts: @Entity('exhibitor_contact')) - nama
    // `exhibitor` terlalu generic & rawan ambigu dengan konsep "exhibitor"
    // sebagai company. pgTable HARUS exhibitor_contact, bukan exhibitor.
    //
    // curr_otp, device_id, token, exhibitor_password SENGAJA tidak disync -
    // itu mekanisme login admin panel PHP lama (email+password), tidak
    // dipakai exhibitor app (yang pakai ev_token + WA OTP terpisah).
    // Tidak perlu duplikasi credential lama ke Postgres.
    mysqlTable: 'exhibitor',
    pgTable: 'exhibitor_contact',
    conflictKeys: ['events_id', 'id'],
    columns: [
      'events_id', 'id', 'fullname', 'country_code', 'phone', 'company_id',
      'approval_status', 'created_date', 'last_update', 'user_level',
      'in_charge', 'job_title', 'exhibitor_email',
    ],
    transform: passthrough,
  },
  {
    mysqlTable: 'exhibitor_product',
    pgTable: 'exhibitor_product',
    conflictKeys: ['events_id', 'company_id', 'id'],
    columns: [
      'events_id', 'company_id', 'id', 'product_name', 'product_url',
      'created', 'salesperson', 'sales_phone', 'product_qr',
      'approval_status', 'brochure', 'promo_url', 'instagram',
      'product_logo', 'investment_fee', 'branch_total', 'brand_established',
      'tiktok_url', 'facebook_url', 'twitter_url', 'product_description',
    ],
    transform: passthrough,
  },
  // --- Manajemen anggota booth exhibitor app (native MySQL table baru,
  // dibuat manual - lihat create-exhibitor_member_status_sync.sql) ---
  {
    mysqlTable: 'exhibitor_member_status_sync',
    pgTable: 'exhibitor_member_status_sync',
    conflictKeys: ['events_id', 'exhibitor_id'],
    columns: [
      'events_id', 'exhibitor_id', 'member_status', 'can_scan', 'can_chat',
      'is_owner', 'invited_by', 'invited_at', 'activated_at', 'removed_at',
      'last_update',
    ],
    transform: passthrough,
  },
  // --- Satu exhibitor_contact bisa mewakili lebih dari satu company
  // (junction table murni, ditemukan Sept 2026 saat desain login exhibitor
  // app - exhibitor_contact.company_id ternyata cuma "company utama" lama,
  // bukan daftar lengkap) ---
  {
    mysqlTable: 'exhibitor_have_company',
    pgTable: 'exhibitor_have_company',
    conflictKeys: ['events_id', 'exhibitor_id', 'company_id'],
    columns: ['events_id', 'exhibitor_id', 'company_id'],
    transform: passthrough,
  },
  // --- My Booth: lead management (native MySQL table baru, dibuat manual
  // - lihat create-exhibitor_lead_sync.sql). Independen dari checkin_booth,
  // nampung semua source (SCAN/EVENT_GUEST/MANUAL). ---
  {
    mysqlTable: 'exhibitor_lead_sync',
    pgTable: 'exhibitor_lead_sync',
    conflictKeys: ['id'],
    columns: [
      'id', 'events_id', 'company_id', 'venue_id', 'space_id',
      'exhibitor_id', 'guests_id', 'source', 'manual_fullname',
      'manual_phone', 'manual_company', 'notes', 'created_at',
      'last_update',
    ],
    transform: passthrough,
  },
];
