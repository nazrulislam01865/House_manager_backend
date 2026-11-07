ALTER TABLE meter_readings ADD COLUMN accepted boolean NOT NULL DEFAULT true;
ALTER TABLE meter_readings ADD COLUMN supersedes_id uuid REFERENCES meter_readings(id);
ALTER TABLE meter_readings DROP CONSTRAINT meter_readings_installation_id_read_at_key;
CREATE UNIQUE INDEX accepted_reading_date_idx ON meter_readings(installation_id,read_at) WHERE accepted;
CREATE OR REPLACE FUNCTION immutable_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Posted ledger entries are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION immutable_ledger_entry();
CREATE OR REPLACE FUNCTION validate_bill_tenancy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM tenancies t JOIN rooms r ON r.id=t.room_id WHERE t.id=NEW.tenancy_id AND t.organization_id=NEW.organization_id AND t.room_id=NEW.room_id AND t.resident_id=NEW.resident_id AND r.house_id=NEW.house_id) THEN RAISE EXCEPTION 'Bill tenancy scope mismatch' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bill_scope_check BEFORE INSERT OR UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION validate_bill_tenancy();
