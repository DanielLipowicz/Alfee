function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated() && Number(req.user?.is_active || 0) === 1) {
    return next();
  }
  if (req.isAuthenticated()) {
    return req.logout(() => res.redirect("/login"));
  }
  return res.redirect("/login");
}

function ensureManager(req, res, next) {
  if (req.user?.role === "manager") {
    return next();
  }
  return res.status(403).render("error", {
    title: "Brak dostepu",
    message: "Ta sekcja jest dostepna tylko dla kierownika.",
  });
}

function ensureEmployee(req, res, next) {
  if (req.user?.role === "employee") {
    return next();
  }
  return res.status(403).render("error", {
    title: "Brak dostepu",
    message: "Ta sekcja jest dostepna tylko dla pracownika.",
  });
}

function ensureAdmin(req, res, next) {
  if (req.user?.role === "admin") {
    return next();
  }
  return res.status(403).render("error", {
    title: "Brak dostepu",
    message: "Ta sekcja jest dostepna tylko dla administratora.",
  });
}

module.exports = {
  ensureAuthenticated,
  ensureManager,
  ensureEmployee,
  ensureAdmin,
};
