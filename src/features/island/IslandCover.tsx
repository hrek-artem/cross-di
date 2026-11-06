type Props = {
  cover?: string | null;
  source?: string;
  onOpen?: () => void;
};

export default function IslandCover({ cover, source, onOpen }: Props) {
  const image = cover ? <img src={cover} alt="" draggable={false} /> : <span aria-hidden="true">♪</span>;

  if (onOpen) {
    return (
      <button className="island-cover" type="button" aria-label={`Open ${source || "source app"}`} onClick={onOpen}>
        {image}
      </button>
    );
  }

  return <span className="island-cover" aria-hidden="true">{image}</span>;
}
