function normalizeSteps(rawSteps) {
  if (!rawSteps) {
    return [];
  }

  const values = Array.isArray(rawSteps) ? rawSteps : [rawSteps];

  return values
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

function withProgress(items) {
  return items.map((item) => {
    const total = Number(item.total_steps || 0);
    const completed = Number(item.completed_steps || 0);
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return {
      ...item,
      total_steps: total,
      completed_steps: completed,
      percentage,
    };
  });
}

module.exports = {
  normalizeSteps,
  withProgress,
};
