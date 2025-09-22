# Wysylki XML field extraction

The route `/huzar/winsad/db/wysylki/mrn/:mrn` enriches each row with parsed XML values. The mapping lives in `src/config/wysylkiXmlConfig.ts` and is split by source column (`odpowiedzXml`, `dokumentXml`, ...). Each field definition exposes the response key (`name`) and an ordered list of dot-notation paths to try inside the parsed XML tree.

## Adding new fields

1. Edit `src/config/wysylkiXmlConfig.ts`.
2. Append an entry to the `fields` array for the relevant source, e.g.
   ```ts
   {
     name: "holderName",
     paths: [
       "IE029PL.CC029C.HolderOfTheTransitProcedure.name",
       "IE028PL.CC028C.HolderOfTheTransitProcedure.name",
     ],
   }
   ```
3. If a tag repeats, use zero-based indexes: `CountryOfRoutingOfConsignment[1].country`.
4. Paths are evaluated in order; the first non-null value wins. Leave the array empty to reserve a slot that always returns `null` for now.
5. No server restart beyond the usual reload is required; the route reads the config at runtime.

We use [`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser) with namespace stripping enabled. If the parser fails (invalid XML), the respective fields resolve to `null` and a warning is logged. When a candidate path throws (typo, missing branch), the error is logged and evaluation continues with the next path.