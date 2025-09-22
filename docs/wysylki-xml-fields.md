# Wysylki XML field extraction

The route `/huzar/winsad/db/wysylki/mrn/:mrn` enriches every row with parsed XML values. The mapping lives in `src/config/wysylkiXmlConfig.ts` and is split by source column (`odpowiedzXml`, `dokumentXml`, ...). Each field descriptor exposes:

- `name`: key that appears in the HTTP response.
- `paths`: ordered list of dot/zero-based paths (use `[index]` to pick array elements explicitly).
- `regex` *(optional)*: a validation pattern; the first candidate value that matches wins.
- `description` *(optional)*: free-form notes for maintainers.

## Adding new fields

1. Edit `src/config/wysylkiXmlConfig.ts`.
2. Append an entry to the `fields` array for the relevant source, e.g.
   ```ts
   {
     name: "holderName",
     paths: [
       "IE029PL.CC029C.HolderOfTheTransitProcedure.ContactPerson[0].name",
       "IE028PL.CC028C.HolderOfTheTransitProcedure.ContactPerson[0].name",
     ],
     regex: "^.+$",
   }
   ```
3. Arrays must be addressed explicitly: `CountryOfRoutingOfConsignment[0].country` selects the first item.
4. Paths are evaluated in order; if a value fails its regex (or the regex is missing/invalid) the next candidate is tried.
5. No server restart beyond the usual reload is required; the route reads the config at runtime.

We use [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) with namespace stripping enabled. If the parser fails (invalid XML), the respective fields resolve to `null` and a warning is logged. When a candidate path throws (typo, missing branch) or fails regex validation, we log once per path/pattern and continue with the remaining candidates.
