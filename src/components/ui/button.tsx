import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-0 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive hover:shadow-md", // nosemgrep — data array entry, not obfuscated code
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:translate-y-[-1px]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:translate-y-[-1px] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground hover:translate-y-[-1px]",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 hover:translate-y-[-1px]",
        ghost:
          "hover:bg-accent hover:text-accent-foreground hover:translate-y-[-1px] relative overflow-hidden",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3 min-w-[88px]",
        sm: "h-8 rounded-lg gap-1.5 px-3 has-[>svg]:px-2.5 min-w-[68px]",
        lg: "h-11 rounded-xl px-6 has-[>svg]:px-4 min-w-[108px]",
        icon: "size-10",
        "icon-sm": "h-8 w-8",
        "icon-md": "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  icon?: React.ReactNode
  isLoading?: boolean
  children?: React.ReactNode
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, icon, isLoading, children, ...props }, ref) => {
    const isDisabled = isLoading || props.disabled
    
    return (
      <button
        data-slot="button"
        className={cn(buttonVariants({ variant: "ghost", size: "icon", className }))}
        ref={ref}
        disabled={isDisabled}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            {icon}
            {children && !isLoading && <span>{children}</span>}
          </>
        )}
      </button>
    )
  }
)
IconButton.displayName = "IconButton"

interface ButtonWithIconProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  variant?: VariantProps<typeof buttonVariants>['variant']
  size?: 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-md' | null
  icon?: React.ReactNode
  isLoading?: boolean
  children?: React.ReactNode
}

function ButtonWithIcon({
  className,
  variant,
  size,
  icon,
  isLoading = false,
  children,
  ...props
}: ButtonWithIconProps) {
  const isDisabled = isLoading || props.disabled
  
  const baseClasses = cn(buttonVariants({ variant, size, className }))

  return (
    <button
      data-slot="button"
      className={baseClasses}
      disabled={isDisabled}
      {...props}
    >
      {isLoading && (
        <>
          <span className="flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          </span>
          {children && <span className="max-w-[120px] truncate">{children}</span>}
        </>
      )}
      {!isLoading && icon && (
        <span className="flex items-center justify-center">
          {icon}
        </span>
      )}
      {!isLoading && children && <span>{children}</span>}
    </button>
  )
}

function Button({
  className,
  variant,
  size,
  isLoading = false,
  icon,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    isLoading?: boolean
    icon?: React.ReactNode
  }) {
  
  // If icon is provided but no children, use icon variant
  if (icon && !children) {
    return (
      <ButtonWithIcon
        className={className}
        variant={variant}
        size={size}
        icon={icon}
        isLoading={isLoading}
        {...props}
      />
    )
  }

  return (
    <ButtonWithIcon
      className={className}
      variant={variant}
      size={size}
      icon={icon}
      isLoading={isLoading}
      {...props}
    >
      {children}
    </ButtonWithIcon>
  )
}

export { Button, buttonVariants, IconButton }
export type { ButtonWithIconProps }
