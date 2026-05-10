import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Minerva',
    short_name: 'Minerva',
    description: 'Schema-driven planner backed by your own Google data.',
    start_url: '/',
    display: 'standalone',
    background_color: '#fbfbfa',
    theme_color: '#7aa7ff',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-icon.svg', sizes: '180x180', type: 'image/svg+xml' },
    ],
  };
}
