 import {
  constantConcurrentUsers,
  csv,
  getParameter,
  global,
  rampConcurrentUsers,
  scenario,
  simulation,
} from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

type RoleAllocations = {
  admin: number;
  manager: number;
  employee: number;
};

const ROLE_WEIGHTS: Array<{ key: keyof RoleAllocations; weight: number }> = [
  { key: "admin", weight: 0.02 },
  { key: "manager", weight: 0.2 },
  { key: "employee", weight: 0.78 },
];

function readPositiveInt(name: string, fallback: string): number {
  const raw = getParameter(name, fallback);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Parametr "${name}" musi byc liczba calkowita >= 1. Otrzymano: "${raw}".`
    );
  }
  return parsed;
}

function readPercent(name: string, fallback: string): number {
  const raw = getParameter(name, fallback);
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Parametr "${name}" musi byc z zakresu 0-100.`);
  }
  return parsed;
}

function allocateUsers(totalUsers: number): RoleAllocations {
  const allocations: RoleAllocations = {
    admin: 0,
    manager: 0,
    employee: 0,
  };

  const fractions = ROLE_WEIGHTS.map((role) => {
    const exact = totalUsers * role.weight;
    const floorValue = Math.floor(exact);
    allocations[role.key] = floorValue;
    return { key: role.key, fraction: exact - floorValue };
  }).sort((left, right) => right.fraction - left.fraction);

  const allocated =
    allocations.admin + allocations.manager + allocations.employee;
  const remainder = totalUsers - allocated;

  for (let index = 0; index < remainder; index += 1) {
    const role = fractions[index % fractions.length];
    allocations[role.key] += 1;
  }

  return allocations;
}

function roleJourney(
  roleName: string,
  feederFile: string,
  landingPath: string
) {
  return scenario(`${roleName} journey`)
    .feed(csv(feederFile).circular())
    .exec(
      http(`${roleName} - GET /login`).get("/login").check(status().is(200))
    )
    .exec(
      http(`${roleName} - POST /login/local`)
        .post("/login/local")
        .formParam("identifier", "#{identifier}")
        .formParam("password", "#{password}")
        .check(status().is(302))
    )
    .exec(
      http(`${roleName} - GET ${landingPath}`)
        .get(landingPath)
        .check(status().is(200))
    )
    .exec(
      http(`${roleName} - GET /profile`).get("/profile").check(status().is(200))
    )
    .exec(
      http(`${roleName} - GET /logout`).get("/logout").check(status().is(302))
    );
}

export default simulation((setUp) => {
  const baseUrl = getParameter("baseUrl", "http://localhost:3000");
  const totalUsers = readPositiveInt("totalUsers", "100");
  const rampSeconds = readPositiveInt("rampSeconds", "60");
  const steadySeconds = readPositiveInt("steadySeconds", "180");
  const maxResponseTimeMs = readPositiveInt("maxResponseTimeMs", "5000");
  const minSuccessfulRequestsPercent = readPercent(
    "minSuccessfulRequestsPercent",
    "95"
  );

  const allocations = allocateUsers(totalUsers);

  console.log(
    `[roleCapacitySimulation] total=${totalUsers}, admin=${allocations.admin}, manager=${allocations.manager}, employee=${allocations.employee}`
  );

  const httpProtocol = http
    .baseUrl(baseUrl)
    .acceptHeader("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    .disableFollowRedirect();

  const adminScenario = roleJourney("admin", "admins.csv", "/admin/organizations");
  const managerScenario = roleJourney(
    "manager",
    "managers.csv",
    "/manager/dashboard"
  );
  const employeeScenario = roleJourney(
    "employee",
    "employees.csv",
    "/employee/tasks"
  );

  const injections = [
    ...(allocations.admin > 0
      ? [
          adminScenario.injectClosed(
            rampConcurrentUsers(0).to(allocations.admin).during(rampSeconds),
            constantConcurrentUsers(allocations.admin).during(steadySeconds)
          ),
        ]
      : []),
    ...(allocations.manager > 0
      ? [
          managerScenario.injectClosed(
            rampConcurrentUsers(0).to(allocations.manager).during(rampSeconds),
            constantConcurrentUsers(allocations.manager).during(steadySeconds)
          ),
        ]
      : []),
    ...(allocations.employee > 0
      ? [
          employeeScenario.injectClosed(
            rampConcurrentUsers(0).to(allocations.employee).during(rampSeconds),
            constantConcurrentUsers(allocations.employee).during(steadySeconds)
          ),
        ]
      : []),
  ];

  setUp(...injections)
    .protocols(httpProtocol)
    .assertions(
      global().responseTime().max().lt(maxResponseTimeMs),
      global().successfulRequests().percent().gt(minSuccessfulRequestsPercent)
    );
});

