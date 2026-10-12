import { useState } from "react";
import Hub from "./features/hub/hub-screen.tsx";
import { configureLanguage } from "./shared/settings.ts";

export default function Command() {
  useState(configureLanguage);
  return <Hub />;
}
