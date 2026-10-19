# Font files

| File | Family | Copyright (from the font's name table) | License |
|---|---|---|---|
| `AtkinsonHyperlegibleNext-Latin-wght200-800.woff2` | Atkinson Hyperlegible Next, Version 2.001, variable weight 200–800, Latin subset | Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next) | SIL Open Font License 1.1, https://openfontlicense.org |
| `AtkinsonHyperlegibleMono-Latin-wght200-800.woff2` | Atkinson Hyperlegible Mono, Version 2.001, variable weight 200–800, Latin subset | Copyright 2020-2024 The Atkinson Hyperlegible Mono Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next-mono) | SIL Open Font License 1.1, https://openfontlicense.org |

These are the unmodified Latin subsets that `next/font/google` had already downloaded from Google Fonts in an earlier build of this project. They are copied here so a build never needs the network: Stage 5 found that a build could fail while fetching them.

- **Coverage:** the Latin subset covers U+0000–00FF plus common punctuation. The synthetic data uses no letters beyond Latin-1, and any other character falls back to the system font.
- **Before any redistribution** beyond this private repository, add the full OFL 1.1 text as `OFL.txt` next to these files. The OFL requires the license to accompany the fonts. The text is at the URL above.
