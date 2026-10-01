import Chat from "@/components/Chat";

export default async function Page({ params }: { params: Promise<{ user: string }> }) {
  const { user } = await params;
  return <Chat me={decodeURIComponent(user).toLowerCase()} />;
}
