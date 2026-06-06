import { NextRequest, NextResponse } from 'next/server';
import { loadEmergencyServices } from '@/lib/data/emergencyServices';
import type { EmergencyServiceType } from '@/types/emergency';

const SERVICE_TYPES = new Set<EmergencyServiceType>(['police', 'fire', 'hospital']);

export function GET(request: NextRequest) {
  const typeParam = request.nextUrl.searchParams.get('type')?.toLowerCase();
  const payload = loadEmergencyServices();

  if (typeParam && SERVICE_TYPES.has(typeParam as EmergencyServiceType)) {
    const type = typeParam as EmergencyServiceType;
    const services = payload.services.filter((service) => service.type === type);
    return NextResponse.json({ services, counts: payload.counts });
  }

  return NextResponse.json(payload);
}
