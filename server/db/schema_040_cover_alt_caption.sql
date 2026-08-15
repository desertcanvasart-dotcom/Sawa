-- 040: the cover image gets its own alt text and caption.
--
-- The blog's first real article arrived with a hero image (15 Aug 2026) and
-- the post page had exactly one thing to say about any cover: alt={title}.
-- The title describes the ARTICLE; alt text describes the PICTURE — a screen
-- reader user standing in front of "Fayoum in a Day from Cairo" learns
-- nothing about the ruined temple gate and desert mounds actually shown.
-- In-body figures got alt and figcaption when the sanitizer learned img/
-- figure/figcaption the same day; the cover was the one image left with no
-- surface for either.
--
-- Both nullable, no defaults: an empty alt falls back to the title at render
-- time (better than nothing), and a missing caption simply renders no
-- caption. Old posts keep behaving exactly as before.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS cover_alt     TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS cover_caption TEXT;
