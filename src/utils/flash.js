function setFlash(req, type, text) {
  if (!req.session) {
    return;
  }
  req.session.flash = { type, text };
}

module.exports = {
  setFlash,
};
