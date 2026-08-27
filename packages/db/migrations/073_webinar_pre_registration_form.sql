ALTER TABLE webinars ADD COLUMN pre_registration_form_id TEXT REFERENCES forms(id);
