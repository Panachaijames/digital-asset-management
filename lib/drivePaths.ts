// The folder tree used by /api/paths, the upload picker's search and
// GET /api/v1/folders.
//
// This used to be a 60 s cache over Drive's whole-drive folder listing. That
// listing turned out to be eventually consistent on a scale of hours, so new
// folders "didn't exist" in the tree long after they were created. The tree
// now comes from lib/folderIndex.ts, which is kept current with the Drive
// Changes API; this module only keeps the import path stable for the routes.
export { getFolderPaths, clearFolderPathCache } from "./folderIndex";
