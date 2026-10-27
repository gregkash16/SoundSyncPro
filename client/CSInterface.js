/* Minimal CSInterface subset for CEP 11/12. */
var SystemPath = {
  USER_DATA: "userData",
  COMMON_FILES: "commonFiles",
  MY_DOCUMENTS: "myDocuments",
  APPLICATION: "application",
  EXTENSION: "extension",
  HOST_APPLICATION: "hostApplication"
};

function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
  if (typeof callback !== "function") callback = function () {};
  window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getHostEnvironment = function () {
  return JSON.parse(window.__adobe_cep__.getHostEnvironment());
};

CSInterface.prototype.getSystemPath = function (pathType) {
  var p = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
  p = p.replace(/^file:\/+/, "");
  if (/^\/[A-Za-z]:/.test(p)) p = p.substring(1);
  return p;
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  return window.cep.util.openURLInDefaultBrowser(url);
};
