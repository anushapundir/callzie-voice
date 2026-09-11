CREATE TABLE "retell_agents" (
	"business_type" text PRIMARY KEY NOT NULL,
	"llm_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
