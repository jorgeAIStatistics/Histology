/**
 * Shared record predicates for the read models, so two screens that count "the same thing" use one
 * definition. SQL fragments name their table aliases.
 */

/**
 * An open routing exception: an intake item with no approved routing rule (decision status `exception`) that is
 * neither accessioned nor canceled. Aliases: `rd` = routing_decision, `ii` = intake_item.
 * Used by Operations (tile and Blocked now), the worklist's routing-exception group and Insights.
 */
export const OPEN_ROUTING_EXCEPTION_SQL = "rd.status = 'exception' AND ii.status NOT IN ('accessioned','canceled')";

/**
 * Who owns an approved gross description waiting for source-system entry when no entry task is open: nobody yet,
 * and the role that should. Operations (Blocked now, owner queue) and the worklist's Owner column say the same words.
 */
export const SOURCE_ENTRY_UNASSIGNED = "Unassigned (histology assistant)";
