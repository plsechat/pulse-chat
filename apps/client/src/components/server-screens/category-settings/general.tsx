import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useAdminCategoryGeneral } from '@/features/server/admin/hooks';
import { memo } from 'react';

type TGeneralProps = {
  categoryId: number;
};

const General = memo(({ categoryId }: TGeneralProps) => {
  const { category, loading, onChange, submit, errors } =
    useAdminCategoryGeneral(categoryId);

  if (!category) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Category Information</CardTitle>
        <CardDescription>
          Manage your category's basic information
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Group label="Name">
          <Input
            value={category.name}
            onChange={(e) => onChange('name', e.target.value)}
            placeholder="Enter category name"
            error={errors.name}
          />
        </Group>

        <SettingsFormFooter
          onCancel={closeServerScreens}
          onSave={submit}
          saving={loading}
        />
      </CardContent>
    </Card>
  );
});

export { General };
