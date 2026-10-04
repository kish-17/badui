import type {
  ConnectionStatus,
  ConsentEvent,
  Direction,
  ObservationKind,
  PromptKind,
  SignalSourceKind,
  SpendWindow,
  TransactionStatus,
  UserAssertion,
  UserRule,
} from "@brake/core";

/**
 * Hand-written schema types in the shape `supabase gen types typescript`
 * produces, so `SupabaseClient<Database>` type-checks every table, column and
 * RPC the store touches. It mirrors `supabase/migrations` (public schema);
 * the `private` schema is deliberately absent because it is not exposed
 * through the API.
 *
 * Where a text column carries a check constraint over a closed set of values,
 * the column is typed with the matching BRAKE union instead of plain
 * `string`, so a typo fails at compile time rather than as a 23514 at runtime.
 * Conventions: timestamptz columns are ISO 8601 strings, bigint columns are
 * numbers (every BRAKE amount and TTL is a safe integer), jsonb is `Json`.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type InstrumentType = "bank_account" | "card" | "wallet" | "upi_handle" | "brokerage" | "loan";
type CardKind = "credit" | "debit" | "prepaid";
type BudgetPeriod = "weekly" | "monthly";

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "13.0.4";
  };
  public: {
    Tables: {
      user_settings: {
        Row: {
          user_id: string;
          locale: string;
          time_zone: string;
          home_country: string | null;
          home_currency: string | null;
          question_weekly_budget: number;
          regret_prompts_enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          locale: string;
          time_zone: string;
          home_country?: string | null;
          home_currency?: string | null;
          question_weekly_budget?: number;
          regret_prompts_enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          locale?: string;
          time_zone?: string;
          home_country?: string | null;
          home_currency?: string | null;
          question_weekly_budget?: number;
          regret_prompts_enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      source_connections: {
        Row: {
          user_id: string;
          connection_id: string;
          adapter_id: string;
          kind: SignalSourceKind;
          label: string;
          provider: string | null;
          status: ConnectionStatus;
          scopes: string[];
          purposes: string[];
          excerpt_ttl_ms: number;
          observation_ttl_ms: number | null;
          granted_at: string;
          updated_at: string;
          revoked_at: string | null;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          connection_id: string;
          adapter_id: string;
          kind: SignalSourceKind;
          label: string;
          provider?: string | null;
          status: ConnectionStatus;
          scopes?: string[];
          purposes?: string[];
          excerpt_ttl_ms: number;
          observation_ttl_ms?: number | null;
          granted_at: string;
          updated_at: string;
          revoked_at?: string | null;
        };
        Update: {
          user_id?: string;
          connection_id?: string;
          adapter_id?: string;
          kind?: SignalSourceKind;
          label?: string;
          provider?: string | null;
          status?: ConnectionStatus;
          scopes?: string[];
          purposes?: string[];
          excerpt_ttl_ms?: number;
          observation_ttl_ms?: number | null;
          granted_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
        };
        Relationships: [];
      };
      consent_events: {
        Row: {
          id: number;
          user_id: string;
          connection_id: string;
          action: ConsentEvent["action"];
          at: string;
          scopes: string[];
          purposes: string[];
        };
        Insert: {
          /** Identity column: assigned by the database. */
          id?: never;
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          connection_id: string;
          action: ConsentEvent["action"];
          at: string;
          scopes?: string[];
          purposes?: string[];
        };
        /** Append-only: API roles hold no UPDATE privilege. */
        Update: {
          id?: never;
          user_id?: never;
          connection_id?: never;
          action?: never;
          at?: never;
          scopes?: never;
          purposes?: never;
        };
        Relationships: [];
      };
      observations: {
        Row: {
          user_id: string;
          id: string;
          connection_id: string;
          adapter_id: string;
          source_kind: SignalSourceKind;
          kind: ObservationKind;
          spend_window: SpendWindow;
          stage: TransactionStatus;
          received_at: string;
          occurred_at: string | null;
          direction: Direction | null;
          amount_minor: number | null;
          currency: string | null;
          merchant_key: string | null;
          confidence: number;
          facts: Json;
          evidence_excerpt: string | null;
          excerpt_expires_at: string | null;
          created_at: string;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          id: string;
          connection_id: string;
          adapter_id: string;
          source_kind: SignalSourceKind;
          kind: ObservationKind;
          spend_window: SpendWindow;
          stage: TransactionStatus;
          received_at: string;
          occurred_at?: string | null;
          direction?: Direction | null;
          amount_minor?: number | null;
          currency?: string | null;
          merchant_key?: string | null;
          confidence: number;
          facts: Json;
          evidence_excerpt?: string | null;
          excerpt_expires_at?: string | null;
          created_at?: string;
        };
        /**
         * Immutable (ADR-002): API roles hold no UPDATE privilege; the store only
         * inserts (ON CONFLICT DO NOTHING) and deletes. Retention updates run as the owner.
         */
        Update: {
          user_id?: never;
          id?: never;
          connection_id?: never;
          adapter_id?: never;
          source_kind?: never;
          kind?: never;
          spend_window?: never;
          stage?: never;
          received_at?: never;
          occurred_at?: never;
          direction?: never;
          amount_minor?: never;
          currency?: never;
          merchant_key?: never;
          confidence?: never;
          facts?: never;
          evidence_excerpt?: never;
          excerpt_expires_at?: never;
          created_at?: never;
        };
        Relationships: [
          {
            foreignKeyName: "observations_user_id_connection_id_fkey";
            columns: ["user_id", "connection_id"];
            isOneToOne: false;
            referencedRelation: "source_connections";
            referencedColumns: ["user_id", "connection_id"];
          },
        ];
      };
      user_assertions: {
        Row: {
          user_id: string;
          id: string;
          kind: UserAssertion["kind"];
          at: string;
          anchors: string[];
          body: Json;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          id: string;
          kind: UserAssertion["kind"];
          at: string;
          anchors: string[];
          body: Json;
        };
        Update: {
          user_id?: string;
          id?: string;
          kind?: UserAssertion["kind"];
          at?: string;
          anchors?: string[];
          body?: Json;
        };
        Relationships: [];
      };
      budgets: {
        Row: {
          user_id: string;
          id: string;
          category: string | null;
          limit_minor: number;
          currency: string;
          period: BudgetPeriod;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          id: string;
          category?: string | null;
          limit_minor: number;
          currency: string;
          period: BudgetPeriod;
        };
        Update: {
          user_id?: string;
          id?: string;
          category?: string | null;
          limit_minor?: number;
          currency?: string;
          period?: BudgetPeriod;
        };
        Relationships: [];
      };
      goals: {
        Row: {
          user_id: string;
          id: string;
          name: string;
          target_minor: number;
          saved_minor: number;
          currency: string;
          target_date: string | null;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          id: string;
          name: string;
          target_minor: number;
          saved_minor: number;
          currency: string;
          target_date?: string | null;
        };
        Update: {
          user_id?: string;
          id?: string;
          name?: string;
          target_minor?: number;
          saved_minor?: number;
          currency?: string;
          target_date?: string | null;
        };
        Relationships: [];
      };
      user_rules: {
        Row: {
          user_id: string;
          id: string;
          description: string;
          level: UserRule["level"];
          rule: Json;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          id: string;
          description: string;
          level: UserRule["level"];
          rule?: Json;
        };
        Update: {
          user_id?: string;
          id?: string;
          description?: string;
          level?: UserRule["level"];
          rule?: Json;
        };
        Relationships: [];
      };
      owned_instruments: {
        Row: {
          user_id: string;
          id: string;
          type: InstrumentType;
          issuer: string | null;
          last4: string | null;
          account_ref: string | null;
          handle: string | null;
          card_kind: CardKind | null;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          id: string;
          type: InstrumentType;
          issuer?: string | null;
          last4?: string | null;
          account_ref?: string | null;
          handle?: string | null;
          card_kind?: CardKind | null;
        };
        Update: {
          user_id?: string;
          id?: string;
          type?: InstrumentType;
          issuer?: string | null;
          last4?: string | null;
          account_ref?: string | null;
          handle?: string | null;
          card_kind?: CardKind | null;
        };
        Relationships: [];
      };
      prompt_log: {
        Row: {
          user_id: string;
          id: string;
          kind: PromptKind;
          anchor: string | null;
          shown_at: string;
          answered_at: string | null;
          answer: string | null;
        };
        Insert: {
          /** Defaults to auth.uid(); the store always sends it explicitly. */
          user_id?: string;
          id: string;
          kind: PromptKind;
          anchor?: string | null;
          shown_at: string;
          answered_at?: string | null;
          answer?: string | null;
        };
        Update: {
          user_id?: string;
          id?: string;
          kind?: PromptKind;
          anchor?: string | null;
          shown_at?: string;
          answered_at?: string | null;
          answer?: string | null;
        };
        Relationships: [];
      };
      /** Public, versioned capability-registry documents: readable by anyone, written only by the service role. */
      capability_registry: {
        Row: {
          version: string;
          published_at: string;
          document: Json;
        };
        Insert: {
          version: string;
          published_at?: string;
          document: Json;
        };
        Update: {
          version?: string;
          published_at?: string;
          document?: Json;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      /** Revoke one of the caller's connections and purge its observations; returns how many were deleted. */
      revoke_connection: {
        Args: { p_connection_id: string; p_at?: string };
        Returns: number;
      };
      /** Every row the caller owns, as one JSON document (data portability). */
      export_my_data: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** Delete every row the caller owns, consent receipts included. */
      erase_my_data: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database["public"];

/** Row type of a public table, e.g. `Tables<"observations">`. */
export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"];
