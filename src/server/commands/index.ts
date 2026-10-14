// Importing this module registers every command.
import "./intake";
import "./clarifications";
import "./worklist";
import "./grossing";
import "./materials";
import "./admin";
import "./demo";

export { executeCommand, mustRun, listCommands } from "./registry";
export type { CommandResult } from "./registry";
