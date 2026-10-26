-- How long an attempt begun before a quiz's end may still run past it (time limit x worst-case
-- accommodation multiplier + late limit + grace), minutes; NULL = untimed/unknown (6 h assumed).
ALTER TABLE bs_quizzes ADD COLUMN over_min INTEGER;
