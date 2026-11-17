export default function Placeholder({ name }: { name: string }) {
  return <section aria-label={name}>
    <h1>{name}</h1>
    <p>This workspace is being built.</p>
  </section>;
}
