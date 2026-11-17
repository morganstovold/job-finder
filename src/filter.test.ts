import { expect, test } from "bun:test";

import { isEmtTitle, isInRange, milesFromHome } from "./filter.ts";
import { isNearbyText } from "./nearby.ts";

const yes = [
  "EMT",
  "EMT - 911 Full Time",
  "EMT/Paramedic - San Francisco Fire Department (H003)",
  "H003- EMT & Paramedic",
  "Emergency Medical Technician (EMT) Non-Safety",
  "Emergency Medical Technician - Single Role",
  "Firefighter/EMT (Single Role)",
  "E.M.T. Basic",
  "Sacramento Fire Emergency Medical Technician",
  "EMS Trainee",
  "EMT - 911/IFT",
  "EMT 911 Interfacility Hybrid",
];
const no = [
  "Paramedic",
  "Paramedic (Alameda)",
  "Flight Nurse",
  "Aircraft Maintenance Technician - RW",
  "Firefighter/FF Paramedic",
  "PT Firefighter/EMT",
  "Advanced EMT",
  "AEMT",
  "Part Time Instructor, Emergency Medical Technologies",
  "Adjunct Associate Professor of Emergency Medical Technologies (EMT) Pool",
  "SkillBridge EMT Intern",
  "Reserve Firefighter/EMT",
  "IFT EMT Part-Time",
  "Event EMT San Francisco CrowdRx",
  "EMT - Interfacility Transport",
  "Wheelchair Van Driver / EMT",
  "EMT Field Training Officer Supervisor",
  "Emergency Medical Services (EMS) Specialist",
];

for (const t of yes) test(`matches: ${t}`, () => expect(isEmtTitle(t)).toBe(true));
for (const t of no) test(`skips: ${t}`, () => expect(isEmtTitle(t)).toBe(false));

test("distance", () => {
  expect(milesFromHome(37.7725, -122.4147)).toBeLessThan(30); // SF
  expect(milesFromHome(34.05, -118.24)).toBeGreaterThan(300); // LA
  expect(
    isInRange({ id: "", source: "", title: "", employer: "", location: "", url: "", lat: 34.05, lng: -118.24 }),
  ).toBe(false);
});

test("nearby text", () => {
  expect(isNearbyText("City and County of San Francisco")).toBe(true);
  expect(isNearbyText("moraga orinda fire district")).toBe(true);
  expect(isNearbyText("Alameda, CA")).toBe(true);
  expect(isNearbyText("City of Chula Vista")).toBe(false);
  expect(isNearbyText("Orange County, CA USA")).toBe(false);
});
