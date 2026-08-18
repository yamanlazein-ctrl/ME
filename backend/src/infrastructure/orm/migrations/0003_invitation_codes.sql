CREATE TABLE "invitation_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"type" varchar(10) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_codes_code_unique" UNIQUE("code")
);

ALTER TABLE "invitation_codes" ADD CONSTRAINT "invitation_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invitation_codes" ADD CONSTRAINT "invitation_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "invitation_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitation_codes" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "invitation_codes_tenant_isolation" ON "invitation_codes" FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE INDEX "idx_invitation_codes_tenant" ON "invitation_codes" USING btree ("tenant_id");
CREATE INDEX "idx_invitation_codes_code" ON "invitation_codes" USING btree ("code");
