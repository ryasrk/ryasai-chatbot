-- Re-index every chunk with the split form of words a PDF extraction glued together (src/lib/glued-words.ts).
-- Data only: the column and its GIN index are unchanged. The expression is TSV_SOURCE_SQL in src/lib/rag-fts.ts,
-- byte-for-byte (rag-fts-postgres.test.ts); new and rebuilt chunks get it from there.
UPDATE "DocumentChunk" SET tsv = to_tsvector('simple', content || ' ' || COALESCE(keywords, '') || ' ' || array_to_string(ARRAY(
    SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(m[1],
      '([[:alpha:]])Õ([[:lower:]])', '\1 \2', 'g'),
      '([[:lower:]])([[:upper:]])', '\1 \2', 'g'),
      '([[:upper:]])([[:upper:]][[:lower:]])', '\1 \2', 'g'),
      '-\s+', '', 'g') || CASE WHEN m[1] ~ '[[:upper:]]{2}[[:lower:]]' AND regexp_replace(regexp_replace(regexp_replace(regexp_replace(m[1],
      '([[:alpha:]])Õ([[:lower:]])', '\1 \2', 'g'),
      '([[:lower:]])([[:upper:]])', '\1 \2', 'g'),
      '([[:upper:]]{2,})([[:lower:]])', '\1 \2', 'g'),
      '-\s+', '', 'g') <> regexp_replace(regexp_replace(regexp_replace(regexp_replace(m[1],
      '([[:alpha:]])Õ([[:lower:]])', '\1 \2', 'g'),
      '([[:lower:]])([[:upper:]])', '\1 \2', 'g'),
      '([[:upper:]])([[:upper:]][[:lower:]])', '\1 \2', 'g'),
      '-\s+', '', 'g') THEN ' ' || regexp_replace(regexp_replace(regexp_replace(regexp_replace(m[1],
      '([[:alpha:]])Õ([[:lower:]])', '\1 \2', 'g'),
      '([[:lower:]])([[:upper:]])', '\1 \2', 'g'),
      '([[:upper:]]{2,})([[:lower:]])', '\1 \2', 'g'),
      '-\s+', '', 'g') ELSE '' END
    FROM regexp_matches(content,
      '([[:alpha:]]+Õ[[:lower:]][[:alpha:]]*|[[:alpha:]]*[[:lower:]][[:upper:]][[:alpha:]]*|[[:alpha:]]*[[:upper:]][[:upper:]][[:lower:]][[:alpha:]]*|[[:alpha:]]+-\s+[[:lower:]]+)',
      'g') AS m), ' ')) WHERE tsv IS NOT NULL;
