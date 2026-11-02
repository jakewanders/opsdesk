export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: { extensions?: Json; operationName?: string; query?: string; variables?: Json };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      activity_events: {
        Row: {
          action: string;
          actor_user_id: string | null;
          changes: NonNullable<Json>;
          created_at: string;
          entity_id: string;
          entity_type: string;
          id: string;
          organization_id: string;
          summary: string;
        };
        ComputedFields: never;
        Insert: {
          action: string;
          actor_user_id?: string | null;
          changes?: NonNullable<Json>;
          created_at?: string;
          entity_id: string;
          entity_type: string;
          id?: string;
          organization_id: string;
          summary: string;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          changes?: NonNullable<Json>;
          created_at?: string;
          entity_id?: string;
          entity_type?: string;
          id?: string;
          organization_id?: string;
          summary?: string;
        };
        Relationships: [
          {
            foreignKeyName: "activity_events_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      customers: {
        Row: {
          archived_at: string | null;
          assigned_to: string | null;
          company_name: string | null;
          created_at: string;
          created_by: string | null;
          display_name: string;
          email: string | null;
          id: string;
          notes: string | null;
          organization_id: string;
          phone: string | null;
          search_text: string | null;
          source: string;
          status: string;
          tags: string[];
          type: string;
          updated_at: string;
          website: string | null;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          assigned_to?: string | null;
          company_name?: string | null;
          created_at?: string;
          created_by?: string | null;
          display_name: string;
          email?: string | null;
          id?: string;
          notes?: string | null;
          organization_id: string;
          phone?: string | null;
          search_text?: never;
          source?: string;
          status?: string;
          tags?: string[];
          type?: string;
          updated_at?: string;
          website?: string | null;
        };
        Update: {
          archived_at?: string | null;
          assigned_to?: string | null;
          company_name?: string | null;
          created_at?: string;
          created_by?: string | null;
          display_name?: string;
          email?: string | null;
          id?: string;
          notes?: string | null;
          organization_id?: string;
          phone?: string | null;
          search_text?: never;
          source?: string;
          status?: string;
          tags?: string[];
          type?: string;
          updated_at?: string;
          website?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "customers_assigned_to_fkey";
            columns: ["organization_id", "assigned_to"];
            isOneToOne: false;
            referencedRelation: "memberships";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "customers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      demo_workspaces: {
        Row: {
          created_at: string;
          kind: string;
          last_reset_at: string | null;
          organization_id: string;
          seed_version: number;
          seeded_at: string | null;
          updated_at: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          kind?: string;
          last_reset_at?: string | null;
          organization_id: string;
          seed_version?: number;
          seeded_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          kind?: string;
          last_reset_at?: string | null;
          organization_id?: string;
          seed_version?: number;
          seeded_at?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "demo_workspaces_organization_fkey";
            columns: ["organization_id", "kind"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id", "kind"];
          },
        ];
      };
      memberships: {
        Row: {
          joined_at: string;
          organization_id: string;
          role: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          joined_at?: string;
          organization_id: string;
          role: string;
          user_id: string;
        };
        Update: {
          joined_at?: string;
          organization_id?: string;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "memberships_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      opportunities: {
        Row: {
          amount_cents: number;
          archived_at: string | null;
          assigned_to: string | null;
          closed_at: string | null;
          created_at: string;
          created_by: string | null;
          customer_id: string;
          description: string | null;
          expected_close_date: string | null;
          id: string;
          lost_reason: string | null;
          organization_id: string;
          probability_percent: number | null;
          stage: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          amount_cents?: number;
          archived_at?: string | null;
          assigned_to?: string | null;
          closed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_id: string;
          description?: string | null;
          expected_close_date?: string | null;
          id?: string;
          lost_reason?: string | null;
          organization_id: string;
          probability_percent?: number | null;
          stage?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          amount_cents?: number;
          archived_at?: string | null;
          assigned_to?: string | null;
          closed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_id?: string;
          description?: string | null;
          expected_close_date?: string | null;
          id?: string;
          lost_reason?: string | null;
          organization_id?: string;
          probability_percent?: number | null;
          stage?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "opportunities_assigned_to_fkey";
            columns: ["organization_id", "assigned_to"];
            isOneToOne: false;
            referencedRelation: "memberships";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "opportunities_customer_fkey";
            columns: ["organization_id", "customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "opportunities_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      organizations: {
        Row: {
          created_at: string;
          created_by: string | null;
          currency: string;
          expires_at: string | null;
          id: string;
          industry: string | null;
          kind: string;
          name: string;
          slug: string | null;
          timezone: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          expires_at?: string | null;
          id?: string;
          industry?: string | null;
          kind?: string;
          name: string;
          slug?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          expires_at?: string | null;
          id?: string;
          industry?: string | null;
          kind?: string;
          name?: string;
          slug?: string | null;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string;
          id: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name: string;
          id: string;
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string;
          id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tasks: {
        Row: {
          archived_at: string | null;
          assigned_to: string | null;
          completed_at: string | null;
          created_at: string;
          created_by: string | null;
          customer_id: string | null;
          description: string | null;
          due_date: string | null;
          id: string;
          opportunity_id: string | null;
          organization_id: string;
          priority: string;
          priority_rank: number | null;
          status: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          assigned_to?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_id?: string | null;
          description?: string | null;
          due_date?: string | null;
          id?: string;
          opportunity_id?: string | null;
          organization_id: string;
          priority?: string;
          priority_rank?: never;
          status?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          assigned_to?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_id?: string | null;
          description?: string | null;
          due_date?: string | null;
          id?: string;
          opportunity_id?: string | null;
          organization_id?: string;
          priority?: string;
          priority_rank?: never;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_assigned_to_fkey";
            columns: ["organization_id", "assigned_to"];
            isOneToOne: false;
            referencedRelation: "memberships";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "tasks_customer_fkey";
            columns: ["organization_id", "customer_id"];
            isOneToOne: false;
            referencedRelation: "customers";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "tasks_opportunity_fkey";
            columns: ["organization_id", "opportunity_id"];
            isOneToOne: false;
            referencedRelation: "opportunities";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "tasks_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      bootstrap_demo_workspace: { Args: Record<PropertyKey, never>; Returns: Json };
      cleanup_enqueue_orphans: { Args: { min_age_hours?: number }; Returns: number };
      cleanup_next_users: {
        Args: { attempted_before: string; max_rows: number };
        Returns: string[];
      };
      cleanup_purge_expired_demos: { Args: { batch_size?: number }; Returns: Json };
      cleanup_purge_expired_keys: { Args: Record<PropertyKey, never>; Returns: number };
      cleanup_queue_size: { Args: Record<PropertyKey, never>; Returns: number };
      cleanup_record_user: {
        Args: { error_code?: string; outcome: string; uid: string };
        Returns: undefined;
      };
      cleanup_user_eligible: { Args: { uid: string }; Returns: boolean };
      create_real_organization: {
        Args: { org_industry?: string; org_name: string; org_timezone?: string };
        Returns: string;
      };
      health_ping: { Args: Record<PropertyKey, never>; Returns: boolean };
      idempotency_abandon: { Args: { p_key: string; p_route: string }; Returns: boolean };
      idempotency_begin: {
        Args: { p_hash: string; p_key: string; p_route: string };
        Returns: Json;
      };
      idempotency_complete: {
        Args: { p_body: Json; p_key: string; p_route: string; p_status: number };
        Returns: boolean;
      };
      move_opportunity_stage: {
        Args: {
          p_expected_updated_at: string;
          p_id: string;
          p_lost_reason: string;
          p_new_stage: string;
        };
        Returns: {
          amount_cents: number;
          archived_at: string | null;
          assigned_to: string | null;
          closed_at: string | null;
          created_at: string;
          created_by: string | null;
          customer_id: string;
          description: string | null;
          expected_close_date: string | null;
          id: string;
          lost_reason: string | null;
          organization_id: string;
          probability_percent: number | null;
          stage: string;
          title: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "opportunities";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      reset_demo_workspace: { Args: { org_id: string }; Returns: Json };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
