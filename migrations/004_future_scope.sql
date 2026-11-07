ALTER TABLE houses ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Dhaka';
ALTER TABLE tariff_versions ADD COLUMN scope_owner_id uuid;
ALTER TABLE tariff_versions ADD CONSTRAINT tariff_owner_scope_fk FOREIGN KEY(organization_id,scope_owner_id) REFERENCES users(organization_id,id);
ALTER TABLE tariff_versions DROP CONSTRAINT tariff_versions_house_id_effective_from_key;
CREATE UNIQUE INDEX tariff_scope_effective_idx ON tariff_versions(house_id,COALESCE(scope_owner_id,'00000000-0000-0000-0000-000000000000'::uuid),effective_from);
CREATE OR REPLACE FUNCTION preserve_creator() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'Record creator is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER rooms_creator_immutable BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION preserve_creator();
CREATE TRIGGER users_creator_immutable BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION preserve_creator();
CREATE TRIGGER tenancies_creator_immutable BEFORE UPDATE ON tenancies FOR EACH ROW EXECUTE FUNCTION preserve_creator();
