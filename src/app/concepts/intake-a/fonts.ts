import styles from "../archived-fonts.module.css";

/**
 * Concept A type pair (archived preview): Instrument Sans for words, JetBrains
 * Mono for identifiers. No longer fetched from Google Fonts at build time (the
 * build must not depend on the network); see ../archived-fonts.module.css.
 */
export const conceptSans = { variable: styles.aSans };
export const conceptMono = { variable: styles.aMono };
