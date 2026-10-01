"use client";

import "@/components/chat.css";
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/newuser");
}